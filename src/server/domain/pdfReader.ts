import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import type { FieldValues } from './importer.js';
import type { LeadFieldKey } from './mapping.js';

// Reads lead pages that have typed text (the "Mortgage Protection Call-in Delivery Notice" layout).
// Each value is placed by where it sits on the page: under which label, in which column.
// Pages with no text (scans, mailer cards) or an unknown layout are left for the AI reader.

export interface ReadIssue {
  field: string;
  message: string;
  /** Holds the lead for review (it can't be imported without a look). */
  blocking: boolean;
  /** missing: OK stays refused until it's filled in. Anything else is cleared by your OK. */
  kind?: 'missing' | 'uncertain' | 'conflict' | 'note';
}

export interface PageRead {
  page: number;
  /** text: read from the page's text. no_text: a scan or image. unknown_layout: text, but not a layout we know. */
  kind: 'text' | 'no_text' | 'unknown_layout';
  fields: FieldValues;
  /** Values that are not lead fields (Last Action, health answer). */
  extra: Record<string, string>;
  /** Everything read, by the label printed on the page. */
  raw: Record<string, string>;
  issues: ReadIssue[];
}

type Slot = LeadFieldKey | `extra:${string}`;

interface LabelDef {
  re: RegExp;
  slot: Slot;
  col: 'left' | 'sub' | 'right';
  /** Values may run over several lines (joined with a space). */
  multiline?: boolean;
  /** Printed name used in raw. */
  name: string;
}

const LABELS: LabelDef[] = [
  { re: /^mortgage identification number:?$/i, slot: 'source_lead_id', col: 'left', name: 'Mortgage Identification Number' },
  { re: /^call-?in date (&|and) time:?$/i, slot: 'callin_date', col: 'left', name: 'Call-in Date & Time' },
  { re: /^last action:?$/i, slot: 'extra:Last Action', col: 'left', name: 'Last Action' },
  { re: /^borrower name:?$/i, slot: 'full_name', col: 'left', multiline: true, name: 'Borrower Name' },
  { re: /^co-?borrower:?$/i, slot: 'coborrower', col: 'left', multiline: true, name: 'Co-Borrower' },
  { re: /^borrower age:?$/i, slot: 'age', col: 'sub', name: 'Borrower Age' },
  { re: /^(borrower )?(date of birth|dob|d\.o\.b\.?|birth ?date):?$/i, slot: 'dob', col: 'left', name: 'Date of Birth' },
  { re: /^lender:?$/i, slot: 'lender', col: 'left', multiline: true, name: 'Lender' },
  { re: /^mortgage amount:?$/i, slot: 'loan_amount', col: 'left', name: 'Mortgage Amount' },
  { re: /^borrower address:?$/i, slot: 'address', col: 'left', multiline: true, name: 'Borrower Address' },
  { re: /^city:?$/i, slot: 'city', col: 'left', multiline: true, name: 'City' },
  { re: /^state:?$/i, slot: 'state', col: 'left', name: 'State' },
  { re: /^zip code:?$/i, slot: 'zip', col: 'sub', name: 'Zip Code' },
  { re: /^county:?$/i, slot: 'county', col: 'left', multiline: true, name: 'County' },
  { re: /^borrower tobacco last 12 mos:?$/i, slot: 'tobacco', col: 'left', name: 'Borrower Tobacco last 12 mos' },
  {
    re: /^borrower: any history of the following:?$/i,
    slot: 'extra:Health history (heart attack, stroke, cancer, diabetes)',
    col: 'left',
    multiline: true,
    name: 'Any History of Heart Attack, Stroke, Cancer, or Diabetes',
  },
  { re: /^called in from:?$/i, slot: 'phone3', col: 'right', name: 'Called in From' },
  { re: /^contact phone number:?$/i, slot: 'phone', col: 'right', name: 'Contact Phone Number' },
  { re: /^alternate phone number:?$/i, slot: 'phone2', col: 'right', name: 'Alternate Phone Number' },
];
/** Second line of the health label. */
const LABEL_CONTINUATION = /^heart attack, stroke, cancer,? or diabetes\??$/i;
/** Footer text in the right column; anything at or below it is ignored. */
const RIGHT_FOOTER = /^\*+\s*this is not an application/i;
/** Fields where two different values on one page mean the page needs a look. */
const CORE: Slot[] = ['full_name', 'phone', 'address', 'city', 'state', 'zip', 'county', 'source_lead_id'];

interface Item {
  str: string;
  x: number;
  y: number;
  h: number;
  /** Direction the text runs, in degrees (0 = left to right on the page as shown). */
  angle?: number;
}

/** Turns the page so its text runs left to right, whatever the page's rotation or the scan's orientation. */
function upright(items: Item[]): Item[] {
  const votes = new Map<number, number>();
  for (const it of items) {
    const a = ((Math.round((it.angle ?? 0) / 90) * 90) % 360 + 360) % 360;
    votes.set(a, (votes.get(a) ?? 0) + it.str.length);
  }
  const angle = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  if (!angle) return items;
  const t = (angle * Math.PI) / 180;
  const cos = Math.round(Math.cos(t));
  const sin = Math.round(Math.sin(t));
  return items.map((it) => ({ ...it, x: it.x * cos + it.y * sin, y: -it.x * sin + it.y * cos, angle: 0 }));
}

/** Minimum number of known labels for a page to count as this layout. */
const MIN_LABELS = 10;

export function readPageItems(page: number, items: Item[]): PageRead {
  const empty = { page, fields: {}, extra: {}, raw: {}, issues: [] };
  const texts = upright(items.filter((i) => i.str.trim()));
  if (texts.length === 0) return { ...empty, kind: 'no_text' };
  const xs = texts.map((t) => t.x);
  const width = Math.max(...xs) - Math.min(...xs) || 1;

  const found: (LabelDef & Item)[] = [];
  const used = new Set<Item>();
  for (const it of texts) {
    const t = it.str.trim().replace(/\s+/g, ' ');
    const def = LABELS.find((l) => l.re.test(t));
    if (def && !found.some((f) => f.slot === def.slot)) {
      found.push({ ...def, ...it });
      used.add(it);
    } else if (LABEL_CONTINUATION.test(t)) used.add(it);
  }
  if (found.length < MIN_LABELS) return { ...empty, kind: 'unknown_layout' };

  const colX = (c: LabelDef['col']) => {
    const xs = found.filter((f) => f.col === c).map((f) => f.x);
    return xs.length ? Math.min(...xs) : null;
  };
  const leftX = colX('left') ?? 0;
  const subX = colX('sub');
  const rightX = colX('right');
  const tol = width * 0.04;
  const rightTop = found.filter((f) => f.col === 'right').reduce((m, f) => Math.min(m, f.y), Infinity);
  const footerY = texts.find((t) => RIGHT_FOOTER.test(t.str.trim()))?.y ?? Infinity;

  // Values per slot, in reading order.
  const values = new Map<Slot, Item[]>();
  for (const it of texts) {
    if (used.has(it)) continue;
    let col: LabelDef['col'];
    if (rightX !== null && it.x >= rightX - tol) col = 'right';
    else if (subX !== null && it.x >= subX - tol) col = 'sub';
    else if (it.x >= leftX - tol) col = 'left';
    else continue;
    if (col === 'right' && (it.y < rightTop || it.y >= footerY)) continue; // the notice text, not lead data
    // A value belongs to the closest label above it in its column. Sub-column values (age, ZIP) sit on the
    // same line as a left-column label, so the sub column falls back to the left column's label when needed.
    const above = (c: LabelDef['col']) =>
      found.filter((f) => f.col === c && f.y < it.y + it.h * 0.2).sort((a, b) => b.y - a.y)[0];
    let label = above(col);
    if (col === 'sub') {
      const left = above('left');
      // Only use the sub-column label when it is on the same row band as the closest left label.
      if (!label || (left && left.y > label.y + it.h * 0.5)) label = left;
    }
    if (!label) continue;
    const list = values.get(label.slot) ?? [];
    list.push(it);
    values.set(label.slot, list);
  }

  const out: PageRead = { ...empty, kind: 'text', fields: {}, extra: {}, raw: {}, issues: [] };
  for (const def of found) {
    const list = (values.get(def.slot) ?? []).sort((a, b) => a.y - b.y || a.x - b.x);
    if (!list.length) continue;
    // Group pieces on the same line.
    const lines: Item[][] = [];
    for (const it of list) {
      const line = lines.find((l) => Math.abs(l[0]!.y - it.y) < it.h * 0.5);
      if (line) line.push(it);
      else lines.push([it]);
    }
    const lineText = lines.map((l) => l.sort((a, b) => a.x - b.x).map((i) => i.str.trim()).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    let value: string;
    if (lineText.length > 1 && !def.multiline) {
      // e.g. "CALL COMPLETED" hidden under "INCOMPLETE": two answers where one is expected.
      const distinct = [...new Set(lineText)];
      value = distinct.join(' / ');
      if (distinct.length > 1) {
        out.issues.push({
          field: def.slot,
          message: `${def.name} has more than one value on the page: ${distinct.map((d) => `"${d}"`).join(' and ')}`,
          blocking: CORE.includes(def.slot),
        });
      } else value = distinct[0]!;
    } else value = lineText.join(' ');
    out.raw[def.name] = value;
    if (def.slot.startsWith('extra:')) out.extra[def.slot.slice(6)] = value;
    else out.fields[def.slot as LeadFieldKey] = value;
  }
  return out;
}

/** Reads every page's text. Pages that need the AI reader come back with kind no_text or unknown_layout. */
export async function readPdfText(data: Uint8Array, onPage?: (n: number, total: number) => void): Promise<PageRead[]> {
  const task = getDocument({ data: new Uint8Array(data), verbosity: 0 });
  const doc = await task.promise;
  try {
    const out: PageRead[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items: Item[] = [];
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        const m = Util.transform(vp.transform, it.transform);
        items.push({ str: it.str, x: m[4]!, y: m[5]!, h: Math.hypot(m[2]!, m[3]!) || it.height, angle: (Math.atan2(m[1]!, m[0]!) * 180) / Math.PI });
      }
      out.push(readPageItems(n, items));
      page.cleanup();
      onPage?.(n, doc.numPages);
    }
    return out;
  } finally {
    await task.destroy();
  }
}

export async function pdfPageCount(data: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(data, { ignoreEncryption: true });
  return doc.getPageCount();
}

/** One page as its own PDF, for sending to an AI reader. */
export async function extractPage(data: Uint8Array, page: number): Promise<Uint8Array> {
  const src = await PDFDocument.load(data, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [p] = await out.copyPages(src, [page - 1]);
  out.addPage(p!);
  return out.save();
}
