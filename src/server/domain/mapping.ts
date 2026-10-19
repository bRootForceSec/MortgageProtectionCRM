// Column mapping: which spreadsheet column feeds which lead field.
// Unmapped columns are not lost: they are kept in lead.extra_json and in import_row.raw_json.

export const LEAD_FIELDS = [
  { key: 'full_name', label: 'Full name', synonyms: ['name', 'full name', 'lead name', 'borrower', 'borrower name', 'client', 'contact', 'insured'] },
  { key: 'first_name', label: 'First name', synonyms: ['first', 'first name', 'fname', 'given name', 'borrower first name'] },
  { key: 'last_name', label: 'Last name', synonyms: ['last', 'last name', 'lname', 'surname', 'family name', 'borrower last name'] },
  { key: 'phone', label: 'Phone', synonyms: ['phone', 'phone number', 'telephone', 'tel', 'cell', 'mobile', 'primary phone', 'home phone', 'phone 1'] },
  { key: 'phone2', label: 'Second phone', synonyms: ['phone 2', 'alt phone', 'alternate phone', 'alternate phone number', 'secondary phone', 'work phone', 'other phone'] },
  { key: 'phone3', label: 'Third phone', synonyms: ['phone 3', 'third phone', 'called in from', 'called from'] },
  { key: 'email', label: 'Email', synonyms: ['email', 'e-mail', 'email address'] },
  { key: 'lender', label: 'Lender', synonyms: ['lender', 'mortgage lender', 'bank', 'mortgage company', 'servicer'] },
  { key: 'loan_amount', label: 'Loan amount', synonyms: ['loan amount', 'loan', 'mortgage amount', 'amount', 'loan amt', 'mortgage'] },
  { key: 'age', label: 'Age', synonyms: ['age', 'borrower age', 'age of borrower'] },
  { key: 'dob', label: 'Date of birth', synonyms: ['dob', 'd o b', 'date of birth', 'birth date', 'birthdate', 'birthday', 'borrower dob', 'borrower date of birth'] },
  { key: 'coborrower', label: 'Co-borrower', synonyms: ['co-borrower', 'coborrower', 'co borrower', 'co-borrower?', 'has co-borrower', 'cobor'] },
  { key: 'address', label: 'Street address', synonyms: ['address', 'street', 'street address', 'property address', 'loan address', 'address 1', 'mailing address'] },
  { key: 'city', label: 'City', synonyms: ['city', 'town'] },
  { key: 'state', label: 'State', synonyms: ['state', 'st', 'province'] },
  { key: 'zip', label: 'ZIP', synonyms: ['zip', 'zip code', 'zipcode', 'postal code', 'postal'] },
  { key: 'county', label: 'County', synonyms: ['county', 'county name', 'parish'] },
  { key: 'source_lead_id', label: 'Lead ID', synonyms: ['lead id', 'mortgage identification number', 'mortgage id', 'lead number', 'lead no'] },
  { key: 'callin_date', label: 'Call-in date', synonyms: ['call in date', 'callin date', 'call in date time', 'call in date & time', 'date called in', 'lead date'] },
  { key: 'lead_type', label: 'Lead type', synonyms: ['lead type', 'lead level', 'lead tier'] },
  { key: 'status', label: 'Status (becomes call history)', synonyms: ['status', 'call status', 'disposition', 'lead status'] },
  { key: 'passphrase', label: 'Passphrase', synonyms: ['passphrase', 'pass phrase', 'password phrase'] },
  { key: 'tobacco', label: 'Tobacco', synonyms: ['tobacco', 'smoker', 'tobacco use', 'smoke', 'nicotine'] },
  { key: 'health_heart', label: 'Heart attack', synonyms: ['heart', 'heart attack', 'heart disease', 'heart condition'] },
  { key: 'health_stroke', label: 'Stroke', synonyms: ['stroke'] },
  { key: 'health_cancer', label: 'Cancer', synonyms: ['cancer'] },
  { key: 'health_diabetes', label: 'Diabetes', synonyms: ['diabetes', 'diabetic'] },
] as const;

export type LeadFieldKey = (typeof LEAD_FIELDS)[number]['key'];

/** Maps lead field key → source column header (exact header text). */
export type ColumnMapping = Partial<Record<LeadFieldKey, string>>;

export function canonicalHeader(h: string): string {
  return h.toLowerCase().replace(/[_\-.:#]+/g, ' ').replace(/[^a-z0-9? ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Guesses a mapping from header names. Exact synonym matches first, then "contains" matches. */
export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  const canon = headers.map((h) => ({ h, c: canonicalHeader(h) }));
  for (const pass of ['exact', 'contains'] as const) {
    for (const f of LEAD_FIELDS) {
      if (mapping[f.key]) continue;
      const hit = canon.find(
        ({ h, c }) =>
          !used.has(h) &&
          f.synonyms.some((s) => {
            const cs = canonicalHeader(s);
            return pass === 'exact' ? c === cs : cs.length >= 4 && cs.includes(' ') ? ` ${c} `.includes(` ${cs} `) : cs.length >= 4 && c.split(' ').includes(cs);
          }),
      );
      if (hit) {
        mapping[f.key] = hit.h;
        used.add(hit.h);
      }
    }
  }
  // A "name" column plus first/last columns: prefer first/last.
  if (mapping.first_name && mapping.last_name) delete mapping.full_name;
  return mapping;
}

/** Stable key for a header layout, used to remember mappings for the same sheet format. */
export function headerKey(headers: string[]): string {
  return headers.map(canonicalHeader).filter(Boolean).sort().join('|');
}

export function validateMapping(mapping: ColumnMapping, headers: string[]): string[] {
  const errors: string[] = [];
  const known = new Set(LEAD_FIELDS.map((f) => f.key as string));
  for (const [k, h] of Object.entries(mapping)) {
    if (!known.has(k)) errors.push(`unknown field "${k}"`);
    if (h && !headers.includes(h)) errors.push(`column "${h}" (for ${k}) is not in the sheet`);
  }
  if (!mapping.phone) errors.push('a Phone column must be mapped');
  if (!mapping.full_name && !mapping.first_name && !mapping.last_name) {
    errors.push('map a Full name column, or First/Last name columns');
  }
  return errors;
}
