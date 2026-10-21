import { createHash } from 'node:crypto';
import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { type ColumnMapping, type LeadFieldKey, LEAD_FIELDS, validateMapping, headerKey } from './mapping.js';
import type { ParsedSheet } from './spreadsheet.js';
import {
  ageOn, coborrowerSignal, normalizeAge, normalizeDob, normalizeCallinDate, normalizeMoneyToCents, normalizeState, normalizeUsPhone,
  normalizeZip, splitName, splitStateZip, toText, timeZoneFor,
} from './normalize.js';
import { resolveCounty, lookupZip } from './county.js';
import { rebuildLeadState } from './leadState.js';
import { recordSheetHistory } from './sheetHistory.js';

export type RowStatus = 'accepted' | 'duplicate_in_file' | 'already_imported' | 'rejected';

export interface LeadDraft {
  first_name: string | null;
  last_name: string | null;
  full_name_raw: string | null;
  phone_raw: string | null;
  phone_e164: string | null;
  phone2_raw: string | null;
  phone2_e164: string | null;
  phone3_raw: string | null;
  phone3_e164: string | null;
  email: string | null;
  lender: string | null;
  loan_amount_cents: number | null;
  loan_amount_raw: string | null;
  age: number | null;
  age_raw: string | null;
  /** Date of birth, YYYY-MM-DD. When set, the age shown is worked out from it. */
  dob: string | null;
  dob_raw: string | null;
  coborrower_raw: string | null;
  coborrower_signal: 'yes' | 'unknown';
  address_line: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  county_key: string | null;
  county_source: string | null;
  time_zone: string | null;
  tobacco_raw: string | null;
  health_heart_raw: string | null;
  health_stroke_raw: string | null;
  health_cancer_raw: string | null;
  health_diabetes_raw: string | null;
  source_lead_id: string | null;
  callin_at: string | null;
  callin_raw: string | null;
  lead_type: string | null;
  status_raw: string | null;
  extra: Record<string, string>;
}

/** Field values for one source row, keyed by lead field. */
export type FieldValues = Partial<Record<LeadFieldKey, string>>;

/** One row from any source (a spreadsheet row through its mapping, or a PDF page). */
export interface SourceRow {
  rowNumber: number;
  /** Original values, kept in import_row.raw_json. */
  raw: Record<string, string>;
  fields: FieldValues;
  /** Source values not mapped to a lead field (kept on the lead). */
  extra?: Record<string, string>;
  page?: number | null;
  /** Lead type chosen for this row at import (overrides a Lead type column). */
  leadType?: string | null;
  /** Set when you discarded the row in review: it is recorded but never becomes a lead. */
  discarded?: string | null;
}

export interface RowResult {
  rowNumber: number;
  status: RowStatus;
  errors: string[];
  warnings: string[];
  fingerprint: string;
  lead: LeadDraft;
  raw: Record<string, string>;
  page: number | null;
  /** Existing leads with the same phone (possible duplicates to link). */
  samePhoneLeadIds: string[];
}

export interface ImportOptions {
  /** Import rows identical to previously imported rows as new leads (e.g. the same person bought again). */
  importRepeatsAsNew?: boolean;
  /** Date the source file was last saved; used as "on or before" for history from a Status column. */
  fileModified?: string | null;
}

export interface PreviewSummary {
  total: number;
  accepted: number;
  rejected: number;
  discarded: number;
  duplicate_in_file: number;
  already_imported: number;
  with_warnings: number;
  possible_duplicates: number;
  in_dead_pile: number;
  file_previously_imported: { batch_id: string; name: string; imported_at: string }[];
  by_county: { county: string; county_key: string | null; count: number }[];
  by_type: { lead_type: string | null; count: number }[];
}

const txt = (v: unknown) => toText(v) || null;

/** Turns field values into a lead, with reasons when something is missing or wrong. */
export function mapFields(f: FieldValues, extra: Record<string, string> = {}): { lead: LeadDraft; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  let first = txt(f.first_name);
  let last = txt(f.last_name);
  const full = txt(f.full_name);
  if (full && !first && !last) ({ first, last } = splitName(full));
  if (!first && !last) errors.push('no name');

  const phones: { raw: string | null; e164: string | null }[] = [];
  const phoneRaw = txt(f.phone);
  const phone = normalizeUsPhone(phoneRaw);
  if (!phoneRaw) errors.push('no phone number');
  else if (phone.problem) errors.push(phone.problem);
  phones.push({ raw: phoneRaw, e164: phone.value });
  // Extra numbers: kept only when they differ from the ones before them.
  for (const [k, label] of [['phone2', 'second'], ['phone3', 'third']] as const) {
    const r = txt(f[k]);
    const n = normalizeUsPhone(r);
    if (n.problem) warnings.push(`${label} ${n.problem}`);
    if (r && n.value && phones.some((p) => p.e164 === n.value)) continue;
    if (r) phones.push({ raw: r, e164: n.value });
  }
  while (phones.length < 3) phones.push({ raw: null, e164: null });

  const loanRaw = txt(f.loan_amount);
  const loan = normalizeMoneyToCents(loanRaw);
  if (loan.problem) warnings.push(loan.problem);

  const ageRaw = txt(f.age);
  const age = normalizeAge(ageRaw);
  if (age.problem) warnings.push(age.problem);
  // A date of birth wins over a printed age: it is exact, and the age it gives stays right as time passes.
  const dobRaw = txt(f.dob);
  const dob = normalizeDob(dobRaw);
  if (dob.problem) warnings.push(dob.problem);
  if (dob.value) {
    const fromDob = ageOn(dob.value);
    if (age.value != null && Math.abs(age.value - fromDob) > 1) {
      warnings.push(`age ${age.value} doesn't match the date of birth (${fromDob}); using the date of birth`);
    }
    age.value = fromDob;
  }

  // "IN 46619" read into the State field (or the ZIP field) is split into the two.
  const sz = splitStateZip(txt(f.state), txt(f.zip));
  const zip = normalizeZip(sz.zip);
  if (zip.problem) warnings.push(zip.problem);
  let st = normalizeState(sz.state);
  if (st.problem) warnings.push(st.problem);
  // No state column (common in hand-made sheets): take it from the ZIP code.
  if (!st.value && zip.value) {
    const z = lookupZip(zip.value);
    if (z) st = { value: z.state };
  }

  const county = resolveCounty({ county: txt(f.county), state: st.value, zip: zip.value, city: txt(f.city) });

  const callinRaw = txt(f.callin_date);
  const callin = normalizeCallinDate(callinRaw, st.value);
  if (callin.problem) warnings.push(callin.problem);

  const passphrase = txt(f.passphrase);
  const allExtra = { ...extra };
  if (passphrase) allExtra.Passphrase = passphrase;

  const coRaw = txt(f.coborrower);
  return {
    errors,
    warnings,
    lead: {
      first_name: first,
      last_name: last,
      full_name_raw: full,
      phone_raw: phones[0]!.raw,
      phone_e164: phones[0]!.e164,
      phone2_raw: phones[1]!.raw,
      phone2_e164: phones[1]!.e164,
      phone3_raw: phones[2]!.raw,
      phone3_e164: phones[2]!.e164,
      email: txt(f.email),
      lender: txt(f.lender),
      loan_amount_cents: loan.value,
      loan_amount_raw: loanRaw,
      age: age.value,
      age_raw: ageRaw,
      dob: dob.value,
      dob_raw: dobRaw,
      coborrower_raw: coRaw,
      coborrower_signal: coborrowerSignal(coRaw),
      address_line: txt(f.address),
      city: txt(f.city),
      state: st.value,
      zip: zip.value,
      county: county?.name ?? txt(f.county),
      county_key: county?.key ?? null,
      county_source: county?.source ?? null,
      time_zone: timeZoneFor(st.value, county?.key ?? null),
      tobacco_raw: txt(f.tobacco),
      health_heart_raw: txt(f.health_heart),
      health_stroke_raw: txt(f.health_stroke),
      health_cancer_raw: txt(f.health_cancer),
      health_diabetes_raw: txt(f.health_diabetes),
      source_lead_id: txt(f.source_lead_id),
      callin_at: callin.value,
      callin_raw: callinRaw,
      lead_type: txt(f.lead_type),
      status_raw: txt(f.status),
      extra: allExtra,
    },
  };
}

/** Spreadsheet row through a column mapping. Unmapped columns become extra fields on the lead. */
export function sheetRowFields(raw: Record<string, string>, m: ColumnMapping): { fields: FieldValues; extra: Record<string, string> } {
  const fields: FieldValues = {};
  for (const [k, col] of Object.entries(m) as [LeadFieldKey, string][]) {
    if (col) {
      const v = toText(raw[col]);
      if (v) fields[k] = v;
    }
  }
  const mappedCols = new Set(Object.values(m).filter(Boolean) as string[]);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (!mappedCols.has(k) && toText(v)) extra[k] = toText(v);
  return { fields, extra };
}

export function mapRow(raw: Record<string, string>, m: ColumnMapping) {
  const { fields, extra } = sheetRowFields(raw, m);
  return mapFields(fields, extra);
}

/**
 * Fingerprint of the mapped content of a row, independent of file and batch.
 * Two rows with the same fingerprint describe the same lead record.
 */
export function rowFingerprint(lead: LeadDraft): string {
  const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v).toLowerCase().replace(/\s+/g, ' ').trim());
  const parts = [
    lead.first_name, lead.last_name, lead.phone_e164 ?? lead.phone_raw, lead.address_line, lead.city,
    lead.state, lead.zip, lead.lender, lead.loan_amount_cents, lead.age,
  ].map(norm);
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

export function sheetSourceRows(sheet: ParsedSheet, mapping: ColumnMapping): SourceRow[] {
  const mErr = validateMapping(mapping, sheet.headers);
  if (mErr.length) throw new MappingError(mErr);
  return sheet.rows.map(({ rowNumber, cells }) => ({ rowNumber, raw: cells, ...sheetRowFields(cells, mapping) }));
}

export function analyzeRows(db: DB, rows: SourceRow[], opts: ImportOptions = {}): RowResult[] {
  const existingFp = db.prepare("SELECT 1 FROM import_row WHERE row_fingerprint = ? AND status = 'accepted' LIMIT 1");
  const existingId = db.prepare('SELECT 1 FROM lead WHERE source_lead_id = ? LIMIT 1');
  const samePhone = db.prepare('SELECT id FROM lead WHERE phone_e164 = ? ORDER BY created_at');
  const seenFp = new Set<string>();
  const seenId = new Map<string, number>();
  const seenPhoneInFile = new Map<string, number>();

  return rows.map((src) => {
    const { lead, errors, warnings } = mapFields(src.fields, src.extra);
    if (src.leadType) lead.lead_type = src.leadType;
    const fingerprint = rowFingerprint(lead);
    let status: RowStatus = 'accepted';
    if (src.discarded) {
      status = 'rejected';
      errors.unshift(`discarded by you: ${src.discarded}`);
    } else if (errors.length) status = 'rejected';
    else if (seenFp.has(fingerprint) || (lead.source_lead_id && seenId.has(lead.source_lead_id))) {
      status = 'duplicate_in_file';
      warnings.push(
        seenFp.has(fingerprint)
          ? 'identical to an earlier row in this file'
          : `same lead ID as ${src.page ? 'page' : 'row'} ${seenId.get(lead.source_lead_id!)}`,
      );
    } else if (!opts.importRepeatsAsNew && (existingFp.get(fingerprint) || (lead.source_lead_id && existingId.get(lead.source_lead_id)))) {
      status = 'already_imported';
      warnings.push('this lead was already imported');
    }
    if (!src.discarded) {
      seenFp.add(fingerprint);
      if (lead.source_lead_id && !seenId.has(lead.source_lead_id)) seenId.set(lead.source_lead_id, src.page ?? src.rowNumber);
    }

    let samePhoneLeadIds: string[] = [];
    if (lead.phone_e164 && status === 'accepted') {
      samePhoneLeadIds = (samePhone.all(lead.phone_e164) as { id: string }[]).map((r) => r.id);
      if (samePhoneLeadIds.length) warnings.push(`same phone as ${samePhoneLeadIds.length} existing lead(s); will be linked as a possible duplicate`);
      const prev = seenPhoneInFile.get(lead.phone_e164);
      if (prev) warnings.push(`same phone as ${src.page ? 'page' : 'row'} ${prev} in this file (co-borrowers often share a phone)`);
      else seenPhoneInFile.set(lead.phone_e164, src.page ?? src.rowNumber);
    }
    return { rowNumber: src.rowNumber, status, errors, warnings, fingerprint, lead, raw: src.raw, page: src.page ?? null, samePhoneLeadIds };
  });
}

export function analyzeSheet(db: DB, sheet: ParsedSheet, mapping: ColumnMapping, opts: ImportOptions = {}): RowResult[] {
  return analyzeRows(db, sheetSourceRows(sheet, mapping), opts);
}

export function deadPilePhones(db: DB): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT l.phone_e164 p FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE s.status = 'dead' AND l.phone_e164 IS NOT NULL")
    .all() as { p: string }[];
  return new Set(rows.map((r) => r.p));
}

export function previewRows(db: DB, sha256: string, source: SourceRow[], opts: ImportOptions = {}) {
  const rows = analyzeRows(db, source, opts);
  const dead = deadPilePhones(db);
  for (const r of rows) {
    if (r.status === 'accepted' && r.lead.phone_e164 && dead.has(r.lead.phone_e164)) {
      r.warnings.push('this phone number belongs to a lead in your dead pile');
    }
  }
  const accepted = rows.filter((r) => r.status === 'accepted');
  const group = <K extends string | null>(f: (r: RowResult) => K) => {
    const m = new Map<K, number>();
    for (const r of accepted) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const summary: PreviewSummary = {
    total: rows.length,
    accepted: accepted.length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
    discarded: source.filter((s) => s.discarded).length,
    duplicate_in_file: rows.filter((r) => r.status === 'duplicate_in_file').length,
    already_imported: rows.filter((r) => r.status === 'already_imported').length,
    with_warnings: rows.filter((r) => r.warnings.length).length,
    possible_duplicates: rows.filter((r) => r.samePhoneLeadIds.length).length,
    in_dead_pile: rows.filter((r) => r.lead.phone_e164 && r.status === 'accepted' && dead.has(r.lead.phone_e164)).length,
    file_previously_imported: db
      .prepare('SELECT id batch_id, name, imported_at FROM import_batch WHERE file_sha256 = ? ORDER BY imported_at')
      .all(sha256) as PreviewSummary['file_previously_imported'],
    by_county: group((r) => r.lead.county_key).map(([county_key, count]) => ({
      county_key,
      county: county_key ? `${accepted.find((r) => r.lead.county_key === county_key)!.lead.county}, ${county_key.split('|')[0]}` : 'Unknown county',
      count,
    })),
    by_type: group((r) => r.lead.lead_type).map(([lead_type, count]) => ({ lead_type, count })),
  };
  return { summary, rows };
}

export function previewImport(db: DB, sha256: string, sheet: ParsedSheet, mapping: ColumnMapping, opts: ImportOptions = {}) {
  return previewRows(db, sha256, sheetSourceRows(sheet, mapping), opts);
}

export interface BatchInput {
  name: string;
  source?: string;
  purchased_count?: number | null;
  cost_total_cents?: number | null;
  cost_per_lead_cents?: number | null;
  lead_type?: string | null;
  lead_age_label?: string | null;
  notes?: string | null;
}

/** Writes the batch, every row (any status), the accepted leads, duplicate links, history and lead state, atomically. */
export function commitRows(
  db: DB,
  file: { fileName: string; sha256: string },
  source: SourceRow[],
  batch: BatchInput,
  meta: Record<string, unknown>,
  opts: ImportOptions = {},
) {
  if (!batch.name?.trim()) throw new MappingError(['batch name is required']);
  return db.transaction(() => {
    const { rows, summary } = previewRows(db, file.sha256, source, opts);
    if (summary.accepted === 0) {
      throw new MappingError(['no new leads to import: every row was rejected, discarded or already imported']);
    }
    const now = nowIso();
    const batchId = uuidv7();
    const prices = new Map(
      (db.prepare('SELECT code, price_cents FROM lead_type').all() as { code: string; price_cents: number | null }[]).map((r) => [r.code, r.price_cents]),
    );
    const accepted = rows.filter((r) => r.status === 'accepted');
    // Cost: what you entered, else the sum of the lead-type prices.
    const priced = accepted.map((r) => (r.lead.lead_type ? prices.get(r.lead.lead_type) ?? null : null));
    const allPriced = priced.length > 0 && priced.every((p) => p != null);
    const totalFromTypes = allPriced ? priced.reduce((a, b) => a! + b!, 0)! : null;
    const costTotal = batch.cost_total_cents ?? totalFromTypes;
    const perLead =
      batch.cost_per_lead_cents ??
      (batch.cost_total_cents != null && (batch.purchased_count || summary.accepted)
        ? Math.round(batch.cost_total_cents / (batch.purchased_count || summary.accepted))
        : null);
    db.prepare(
      `INSERT INTO import_batch (id, name, source, file_name, file_sha256, imported_at, purchased_count,
        cost_total_cents, cost_per_lead_cents, lead_type, lead_age_label, column_mapping_json, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      batchId, batch.name.trim(), batch.source ?? 'opt_lead_manager', file.fileName, file.sha256, now,
      batch.purchased_count ?? null, costTotal, perLead, batch.lead_type ?? null,
      batch.lead_age_label ?? null, JSON.stringify(meta), batch.notes ?? null,
    );
    const insRow = db.prepare(
      `INSERT INTO import_row (id, batch_id, row_number, raw_json, row_fingerprint, status, errors_json, warnings_json, lead_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const insLead = db.prepare(
      `INSERT INTO lead (id, batch_id, import_row_id, first_name, last_name, full_name_raw, phone_raw, phone_e164, phone_valid,
        phone2_raw, phone2_e164, phone3_raw, phone3_e164, email, lender, loan_amount_cents, loan_amount_raw, age, age_raw, dob, dob_raw,
        coborrower_raw, coborrower_signal, address_line, city, state, zip, county, county_key, county_source, time_zone,
        tobacco_raw, health_heart_raw, health_stroke_raw, health_cancer_raw, health_diabetes_raw, extra_json,
        lead_type, price_cents, source_lead_id, callin_at, callin_raw, source_page, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insLink = db.prepare(
      `INSERT OR IGNORE INTO lead_link (id, lead_a, lead_b, reason, created_at) VALUES (?,?,?,'same_phone',?)`,
    );
    const newLeadIds: string[] = [];
    const history: { leadId: string; status: string; phone: string }[] = [];
    const phoneToNewLeads = new Map<string, string[]>();
    for (const r of rows) {
      const rowId = uuidv7();
      const leadId = r.status === 'accepted' ? uuidv7() : null;
      const raw = r.page ? { ...r.raw, __page: String(r.page) } : r.raw;
      insRow.run(
        rowId, batchId, r.rowNumber, JSON.stringify(raw), r.fingerprint, r.status,
        r.errors.length ? JSON.stringify(r.errors) : null, r.warnings.length ? JSON.stringify(r.warnings) : null, leadId,
      );
      if (!leadId) continue;
      const l = r.lead;
      const price = l.lead_type ? prices.get(l.lead_type) ?? null : perLead;
      insLead.run(
        leadId, batchId, rowId, l.first_name, l.last_name, l.full_name_raw, l.phone_raw, l.phone_e164, l.phone_e164 ? 1 : 0,
        l.phone2_raw, l.phone2_e164, l.phone3_raw, l.phone3_e164, l.email, l.lender, l.loan_amount_cents, l.loan_amount_raw,
        l.age, l.age_raw, l.dob, l.dob_raw, l.coborrower_raw, l.coborrower_signal, l.address_line, l.city, l.state, l.zip,
        l.county, l.county_key, l.county_source, l.time_zone, l.tobacco_raw,
        l.health_heart_raw, l.health_stroke_raw, l.health_cancer_raw, l.health_diabetes_raw,
        Object.keys(l.extra).length ? JSON.stringify(l.extra) : null,
        l.lead_type, price, l.source_lead_id, l.callin_at, l.callin_raw, r.page, now,
      );
      newLeadIds.push(leadId);
      if (l.status_raw && l.phone_e164) history.push({ leadId, status: l.status_raw, phone: l.phone_e164 });
      for (const other of r.samePhoneLeadIds) insLink.run(uuidv7(), other, leadId, now);
      if (l.phone_e164) {
        const list = phoneToNewLeads.get(l.phone_e164) ?? [];
        for (const other of list) insLink.run(uuidv7(), other, leadId, now);
        list.push(leadId);
        phoneToNewLeads.set(l.phone_e164, list);
      }
    }
    const historyResult = recordSheetHistory(db, history, opts.fileModified ?? now);
    rebuildLeadState(db, newLeadIds);
    return { batchId, summary, rows, history: historyResult };
  })();
}

/** Spreadsheet import in one step (kept for the CLI-style flow and tests); remembers the mapping. */
export function commitImport(
  db: DB,
  file: { fileName: string; sha256: string },
  sheet: ParsedSheet,
  mapping: ColumnMapping,
  batch: BatchInput,
  opts: ImportOptions = {},
) {
  const result = commitRows(db, file, sheetSourceRows(sheet, mapping), batch, { sheet: sheet.name, headerRow: sheet.headerRow, mapping }, opts);
  saveMapping(db, sheet.headers, mapping);
  return result;
}

export function saveMapping(db: DB, headers: string[], mapping: ColumnMapping) {
  db.prepare(
    `INSERT INTO saved_mapping (id, name, header_key, mapping_json, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET header_key = excluded.header_key, mapping_json = excluded.mapping_json, updated_at = excluded.updated_at`,
  ).run(uuidv7(), `auto:${headerKey(headers)}`, headerKey(headers), JSON.stringify(mapping), nowIso());
}

export function savedMappingFor(db: DB, headers: string[]): ColumnMapping | null {
  const row = db
    .prepare('SELECT mapping_json FROM saved_mapping WHERE header_key = ? ORDER BY updated_at DESC LIMIT 1')
    .get(headerKey(headers)) as { mapping_json: string } | undefined;
  if (!row) return null;
  const m = JSON.parse(row.mapping_json) as ColumnMapping;
  // Drop any column that no longer exists.
  for (const k of Object.keys(m) as (keyof ColumnMapping)[]) if (!headers.includes(m[k]!)) delete m[k];
  return m;
}

export class MappingError extends Error {
  constructor(public problems: string[]) {
    super(problems.join('; '));
  }
}

export const FIELD_LABELS = Object.fromEntries(LEAD_FIELDS.map((f) => [f.key, f.label]));
