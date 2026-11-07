import * as z from 'zod/v4';

// Custom fields: your own fields on every lead. The field kinds, and the one form each kind's value is kept in, so a
// filter, a rule or a formula reads the same thing whoever typed it.

export const CUSTOM_FIELD_TYPES = [
  { key: 'text', label: 'Text' },
  { key: 'number', label: 'Number' },
  { key: 'money', label: 'Money ($)' },
  { key: 'date', label: 'Date' },
  { key: 'yes_no', label: 'Yes / no' },
  { key: 'choice', label: 'Pick from a list' },
  { key: 'formula', label: 'Formula (worked out)' },
  { key: 'counter', label: 'Counter (rules change it)' },
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]['key'];
const TYPE_KEYS = CUSTOM_FIELD_TYPES.map((t) => t.key) as [CustomFieldType, ...CustomFieldType[]];

export const CustomFieldInput = z.object({
  label: z.string().trim().min(1, 'give the field a name').max(60),
  type: z.enum(TYPE_KEYS),
  /** The choices, for "Pick from a list". */
  options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  /** The formula, for "Formula" (shared/formula.ts). */
  formula: z.string().max(2000).optional(),
});
export type CustomFieldInput = z.infer<typeof CustomFieldInput>;

export interface CustomField {
  id: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  sort_order: number;
  /** How many leads have a value. */
  leads: number;
  /** For a formula field: the formula, and what it works out to (null when it has a mistake). */
  formula: string | null;
  result: 'number' | 'text' | 'yes_no' | null;
}

/** Whether a field holds numbers (so it can be filtered by a range and sorted by). */
export function isNumericField(f: Pick<CustomField, 'type' | 'result'>): boolean {
  return f.type === 'number' || f.type === 'money' || f.type === 'counter' || (f.type === 'formula' && f.result === 'number');
}

/**
 * The value as it's kept: numbers plain ("1250.5"), money in dollars with cents ("1250.50"), dates YYYY-MM-DD,
 * yes/no "yes" or "no", a choice exactly as listed. Blank is null. Throws a message for the user when it doesn't fit.
 */
export function normalizeCustomValue(f: Pick<CustomField, 'label' | 'type' | 'options'>, raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const bad = (what: string) => new Error(`${f.label}: ${what}`);
  switch (f.type) {
    case 'text':
      return v.slice(0, 2000);
    case 'number':
    case 'money': {
      const n = Number(v.replace(/[$,\s]/g, ''));
      if (!Number.isFinite(n)) throw bad('needs a number');
      return f.type === 'money' ? n.toFixed(2) : String(n);
    }
    case 'date': {
      const iso8601 = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const parts: [string, string, string] | null = iso8601 ? [iso8601[1]!, iso8601[2]!, iso8601[3]!] : us ? [us[3]!, us[1]!, us[2]!] : null;
      if (!parts) throw bad('needs a date like 11/6/2026');
      const iso = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      const t = new Date(`${iso}T12:00:00Z`);
      if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso) throw bad('that date does not exist');
      return iso;
    }
    case 'yes_no': {
      const s = v.toLowerCase();
      if (['yes', 'y', 'true', '1'].includes(s)) return 'yes';
      if (['no', 'n', 'false', '0'].includes(s)) return 'no';
      throw bad('needs yes or no');
    }
    case 'formula':
      throw bad('is worked out from its formula');
    case 'counter': {
      const n = Number(v);
      if (!Number.isInteger(n)) throw bad('needs a whole number');
      return String(n);
    }
    case 'choice': {
      const hit = f.options.find((o) => o.toLowerCase() === v.toLowerCase());
      if (!hit) throw bad(`pick one of ${f.options.join(', ')}`);
      return hit;
    }
  }
}

/** A kept value as you read it. */
export function showCustomValue(f: Pick<CustomField, 'type'> & { result?: CustomField['result'] }, v: string | null | undefined): string {
  if (v == null || v === '') return '';
  if (f.type === 'formula') return f.result === 'yes_no' ? (v === 'yes' ? 'Yes' : 'No') : v;
  if (f.type === 'money') return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (f.type === 'yes_no') return v === 'yes' ? 'Yes' : 'No';
  if (f.type === 'date') {
    const [y, m, d] = v.split('-');
    return `${Number(m)}/${Number(d)}/${y}`;
  }
  return v;
}
