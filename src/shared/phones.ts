// A lead's phone numbers other than the main one, as the server sends them and the UI shows them.

export interface OtherPhone {
  /** As imported or typed. */
  raw: string | null;
  /** Null when the number isn't a valid US number. */
  e164: string | null;
  /** What the number is: "Alternate", "Called in from", or what you typed. */
  label: string | null;
}

// Other numbers while a lead is being imported: one per line, "Label: number" or just the number
// ("Alternate: (317) 555-0101", "Cell: 317-555-0102"). The AI reader, the typed page reader and the import
// review form write this; the importer turns it into the lead's other numbers.

export interface PhoneLine {
  number: string;
  label: string;
}

/** "Cell: 317-555-0102" → { label: 'Cell', number: '317-555-0102' }; a line with no label keeps an empty one. */
export function parsePhoneLines(text: string | null | undefined): PhoneLine[] {
  if (!text) return [];
  const out: PhoneLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const m = s.match(/^([A-Za-z][^:]*?)\s*:\s*(.+)$/);
    out.push(m ? { label: m[1]!.trim(), number: m[2]!.trim() } : { label: '', number: s });
  }
  return out;
}

export function phoneLinesText(rows: PhoneLine[]): string {
  return rows
    .filter((r) => r.number.trim())
    .map((r) => (r.label.trim() ? `${r.label.trim()}: ${r.number.trim()}` : r.number.trim()))
    .join('\n');
}

const digits = (s: string) => {
  const d = s.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
};

/** Adds a number unless the same digits are already there (or are the main number). */
export function addPhoneLine(rows: PhoneLine[], line: PhoneLine, main?: string | null): PhoneLine[] {
  const d = digits(line.number);
  if (!d) return rows;
  if (main && digits(main) === d) return rows;
  if (rows.some((r) => digits(r.number) === d)) return rows;
  return [...rows, line];
}
