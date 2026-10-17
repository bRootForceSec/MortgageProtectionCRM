// Pure normalization helpers for imported values. Each returns the normalized value plus,
// when something looks wrong, a human-readable problem. Raw values are always kept separately.

export interface Normalized<T> {
  value: T | null;
  problem?: string;
}

/** US phone numbers to E.164 (+1XXXXXXXXXX). Accepts common formats and extensions are rejected. */
export function normalizeUsPhone(raw: unknown): Normalized<string> {
  const s = toText(raw);
  if (!s) return { value: null };
  if (/x|ext/i.test(s)) return { value: null, problem: `phone has an extension: "${s}"` };
  let digits = s.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return { value: null, problem: `phone is not 10 digits: "${s}"` };
  // NANP: area code and exchange cannot start with 0 or 1.
  if (/^[01]/.test(digits) || /^[01]/.test(digits.slice(3))) {
    return { value: null, problem: `phone is not a valid US number: "${s}"` };
  }
  if (/^(\d)\1{9}$/.test(digits)) return { value: null, problem: `phone looks like a placeholder: "${s}"` };
  return { value: `+1${digits}` };
}

export function formatUsPhone(e164: string | null | undefined): string {
  if (!e164 || !/^\+1\d{10}$/.test(e164)) return e164 ?? '';
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** "$286,000", "286000", "286k" → cents. */
export function normalizeMoneyToCents(raw: unknown): Normalized<number> {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: Math.round(raw * 100) };
  const s = toText(raw);
  if (!s) return { value: null };
  const m = s.replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!m) return { value: null, problem: `amount not understood: "${s}"` };
  let n = Number(m[1]);
  if (m[2]?.toLowerCase() === 'k') n *= 1_000;
  if (m[2]?.toLowerCase() === 'm') n *= 1_000_000;
  return { value: Math.round(n * 100) };
}

export function normalizeAge(raw: unknown): Normalized<number> {
  const s = toText(raw);
  if (!s) return { value: null };
  const n = Number(s.replace(/\s*(yrs?|years?)$/i, ''));
  if (!Number.isInteger(n)) return { value: null, problem: `age not a whole number: "${s}"` };
  if (n < 16 || n > 110) return { value: null, problem: `age out of range: "${s}"` };
  return { value: n };
}

/** Interprets yes/no style flags. Returns null when blank or unrecognized. */
export function parseYesNo(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  const s = toText(raw).toLowerCase();
  if (!s) return null;
  if (['y', 'yes', 'true', '1', 'x', 'checked'].includes(s)) return true;
  if (['n', 'no', 'false', '0', 'none', 'unchecked'].includes(s)) return false;
  return null;
}

/**
 * Co-borrower field is unreliable when negative (per the brief), so "no" is stored as unknown.
 */
export function coborrowerSignal(raw: unknown): 'yes' | 'unknown' {
  return parseYesNo(raw) === true ? 'yes' : 'unknown';
}

export function normalizeState(raw: unknown): Normalized<string> {
  const s = toText(raw).toUpperCase();
  if (!s) return { value: null };
  if (STATE_TZ[s]) return { value: s };
  const byName = STATE_NAMES[s];
  if (byName) return { value: byName };
  return { value: null, problem: `state not recognized: "${toText(raw)}"` };
}

export function normalizeZip(raw: unknown): Normalized<string> {
  const s = toText(raw);
  if (!s) return { value: null };
  const m = s.match(/^(\d{5})(?:-?\d{4})?$/) ?? (/^\d{4}$/.test(s) ? [s, `0${s}`] : null);
  if (!m) return { value: null, problem: `ZIP not recognized: "${s}"` };
  return { value: m[1]! };
}

/** Splits "Doe, Jane" or "Jane Doe" into parts. Keeps the raw string elsewhere. */
export function splitName(raw: unknown): { first: string | null; last: string | null } {
  const s = toText(raw).replace(/\s+/g, ' ');
  if (!s) return { first: null, last: null };
  if (s.includes(',')) {
    const [last, first] = s.split(',', 2).map((p) => p.trim());
    return { first: first || null, last: last || null };
  }
  const parts = s.split(' ');
  if (parts.length === 1) return { first: parts[0]!, last: null };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1]! };
}

export function toText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  // Spreadsheet dates arrive as UTC-encoded wall-clock times; keep the time when there is one.
  if (raw instanceof Date) return raw.getUTCHours() || raw.getUTCMinutes() ? raw.toISOString().slice(0, 16) : raw.toISOString().slice(0, 10);
  if (typeof raw === 'object') {
    const o = raw as any;
    if (typeof o.text === 'string') return o.text.trim(); // exceljs rich text / hyperlink
    if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join('').trim();
    if (o.result !== undefined) return toText(o.result); // exceljs formula
    return JSON.stringify(raw);
  }
  return String(raw).trim();
}

const TZ_ABBR: Record<string, number> = { EDT: -4, EST: -5, CDT: -5, CST: -6, MDT: -6, MST: -7, PDT: -7, PST: -8, AKDT: -8, AKST: -9, HST: -10 };

/** Offset in minutes of an IANA zone at a given UTC instant. */
function zoneOffsetMinutes(tz: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Call-in dates as printed on lead pages: "7/15/2026 11:31 AM EDT", "04/01/26 9:21 am", "2026-07-15T11:31".
 * Without a zone the time is read as local time in the lead's state. Returns UTC ISO.
 */
export function normalizeCallinDate(raw: unknown, state?: string | null): Normalized<string> {
  const s = toText(raw).replace(/\s+/g, ' ');
  if (!s) return { value: null };
  let y: number, mo: number, d: number, h = 0, mi = 0;
  let zone: string | undefined;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?: (\d{1,2}):(\d{2})(?::\d{2})? ?([AaPp][Mm])?)?(?: ([A-Z]{3,4}))?$/);
  if (m) {
    mo = +m[1]!; d = +m[2]!; y = +m[3]!; if (y < 100) y += 2000;
    if (m[4]) {
      h = +m[4]; mi = +m[5]!;
      const ap = m[6]?.toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
    }
    zone = m[7];
  } else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/))) {
    y = +m[1]!; mo = +m[2]!; d = +m[3]!;
    if (m[4]) { h = +m[4]; mi = +m[5]!; }
  } else {
    return { value: null, problem: `call-in date not understood: "${s}"` };
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return { value: null, problem: `call-in date not understood: "${s}"` };
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let offset: number;
  if (zone && TZ_ABBR[zone] !== undefined) offset = TZ_ABBR[zone]! * 60;
  else offset = zoneOffsetMinutes(STATE_TZ[state ?? '']?.tz ?? 'America/New_York', new Date(wall));
  return { value: new Date(wall - offset * 60000).toISOString() };
}

// Primary IANA zone per state. States split across zones are flagged so calling-hour checks
// (Phase 2) can use the stricter interpretation.
export const STATE_TZ: Record<string, { tz: string; split?: boolean }> = {
  AL: { tz: 'America/Chicago' }, AK: { tz: 'America/Anchorage', split: true }, AZ: { tz: 'America/Phoenix' },
  AR: { tz: 'America/Chicago' }, CA: { tz: 'America/Los_Angeles' }, CO: { tz: 'America/Denver' },
  CT: { tz: 'America/New_York' }, DE: { tz: 'America/New_York' }, DC: { tz: 'America/New_York' },
  FL: { tz: 'America/New_York', split: true }, GA: { tz: 'America/New_York' }, HI: { tz: 'Pacific/Honolulu' },
  ID: { tz: 'America/Boise', split: true }, IL: { tz: 'America/Chicago' }, IN: { tz: 'America/Indiana/Indianapolis', split: true },
  IA: { tz: 'America/Chicago' }, KS: { tz: 'America/Chicago', split: true }, KY: { tz: 'America/New_York', split: true },
  LA: { tz: 'America/Chicago' }, ME: { tz: 'America/New_York' }, MD: { tz: 'America/New_York' },
  MA: { tz: 'America/New_York' }, MI: { tz: 'America/Detroit', split: true }, MN: { tz: 'America/Chicago' },
  MS: { tz: 'America/Chicago' }, MO: { tz: 'America/Chicago' }, MT: { tz: 'America/Denver' },
  NE: { tz: 'America/Chicago', split: true }, NV: { tz: 'America/Los_Angeles' }, NH: { tz: 'America/New_York' },
  NJ: { tz: 'America/New_York' }, NM: { tz: 'America/Denver' }, NY: { tz: 'America/New_York' },
  NC: { tz: 'America/New_York' }, ND: { tz: 'America/Chicago', split: true }, OH: { tz: 'America/New_York' },
  OK: { tz: 'America/Chicago' }, OR: { tz: 'America/Los_Angeles', split: true }, PA: { tz: 'America/New_York' },
  RI: { tz: 'America/New_York' }, SC: { tz: 'America/New_York' }, SD: { tz: 'America/Chicago', split: true },
  TN: { tz: 'America/Chicago', split: true }, TX: { tz: 'America/Chicago', split: true }, UT: { tz: 'America/Denver' },
  VT: { tz: 'America/New_York' }, VA: { tz: 'America/New_York' }, WA: { tz: 'America/Los_Angeles' },
  WV: { tz: 'America/New_York' }, WI: { tz: 'America/Chicago' }, WY: { tz: 'America/Denver' },
  PR: { tz: 'America/Puerto_Rico' },
};

const STATE_NAMES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY',
  LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
  'PUERTO RICO': 'PR',
};

const KEEP_UPPER = new Set(['LLC', 'LP', 'LLP', 'FSB', 'NA', 'USA', 'FCU', 'CU', 'II', 'III', 'IV', 'PO', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'MTG', 'HM', 'DHI', 'FHA', 'VA', 'USAA', 'PNC', 'TD', 'BMO']);

/**
 * Title Case for values printed in capitals ("12971 RAWLINGS CT" → "12971 Rawlings Ct"), as your lead
 * sheets use. Values already in mixed case are left alone. Suffixes like LLC and directions like NW stay
 * upper case; ordinals become "2nd".
 */
export function titleCaseIfShouting(v: string | null | undefined, opts: { keepUpper?: boolean } = {}): string | null {
  if (!v) return v ?? null;
  const letters = v.replace(/[^A-Za-z]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return v;
  return v
    .toLowerCase()
    .replace(/[a-z0-9']+/g, (w) => {
      const up = w.toUpperCase();
      if (opts.keepUpper !== false && KEEP_UPPER.has(up)) return up;
      if (/^\d+(st|nd|rd|th)$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .replace(/\bMc([a-z])/g, (_, c: string) => `Mc${c.toUpperCase()}`)
    .replace(/\b([A-Z])'([a-z])/g, (_, a: string, b: string) => `${a}'${b.toUpperCase()}`);
}
