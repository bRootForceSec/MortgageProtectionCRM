import { createHash } from 'node:crypto';
import type { DB } from '../db/connection.js';
import { uuidv7, nowIso } from '../ids.js';
import { type ColumnMapping, LEAD_FIELDS, validateMapping, headerKey } from './mapping.js';
import type { ParsedSheet } from './spreadsheet.js';
import {
  coborrowerSignal, normalizeAge, normalizeMoneyToCents, normalizeState, normalizeUsPhone,
  normalizeZip, splitName, STATE_TZ, toText,
} from './normalize.js';
import { rebuildLeadState } from './leadState.js';

export type RowStatus = 'accepted' | 'duplicate_in_file' | 'already_imported' | 'rejected';

export interface LeadDraft {
  first_name: string | null;
  last_name: string | null;
  full_name_raw: string | null;
  phone_raw: string | null;
  phone_e164: string | null;
  phone2_raw: string | null;
  phone2_e164: string | null;
  email: string | null;
  lender: string | null;
  loan_amount_cents: number | null;
  loan_amount_raw: string | null;
  age: number | null;
  age_raw: string | null;
  coborrower_raw: string | null;
  coborrower_signal: 'yes' | 'unknown';
  address_line: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  time_zone: string | null;
  tobacco_raw: string | null;
  health_heart_raw: string | null;
  health_stroke_raw: string | null;
  health_cancer_raw: string | null;
  health_diabetes_raw: string | null;
  extra: Record<string, string>;
}

export interface RowResult {
  rowNumber: number;
  status: RowStatus;
  errors: string[];
  warnings: string[];
  fingerprint: string;
  lead: LeadDraft;
  raw: Record<string, string>;
  /** Existing leads with the same phone (possible duplicates to link). */
  samePhoneLeadIds: string[];
}

export interface ImportOptions {
  /** Import rows identical to previously imported rows as new leads (e.g. the same person bought again). */
  importRepeatsAsNew?: boolean;
}

export interface PreviewSummary {
  total: number;
  accepted: number;
  rejected: number;
  duplicate_in_file: number;
  already_imported: number;
  with_warnings: number;
  possible_duplicates: number;
  in_dead_pile: number;
  file_previously_imported: { batch_id: string; name: string; imported_at: string }[];
}

const cell = (raw: Record<string, string>, col?: string) => (col ? toText(raw[col]) : '') || null;

export function mapRow(raw: Record<string, string>, m: ColumnMapping): { lead: LeadDraft; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  let first = cell(raw, m.first_name);
  let last = cell(raw, m.last_name);
  const full = cell(raw, m.full_name);
  if (full && !first && !last) ({ first, last } = splitName(full));
  if (!first && !last) errors.push('no name');

  const phoneRaw = cell(raw, m.phone);
  const phone = normalizeUsPhone(phoneRaw);
  if (!phoneRaw) errors.push('no phone number');
  else if (phone.problem) errors.push(phone.problem);

  const phone2Raw = cell(raw, m.phone2);
  const phone2 = normalizeUsPhone(phone2Raw);
  if (phone2.problem) warnings.push(`second ${phone2.problem}`);

  const loanRaw = cell(raw, m.loan_amount);
  const loan = normalizeMoneyToCents(loanRaw);
  if (loan.problem) warnings.push(loan.problem);

  const ageRaw = cell(raw, m.age);
  const age = normalizeAge(ageRaw);
  if (age.problem) warnings.push(age.problem);

  const st = normalizeState(cell(raw, m.state));
  if (st.problem) warnings.push(st.problem);
  const zip = normalizeZip(cell(raw, m.zip));
  if (zip.problem) warnings.push(zip.problem);

  const mappedCols = new Set(Object.values(m).filter(Boolean) as string[]);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (!mappedCols.has(k) && v) extra[k] = v;

  const coRaw = cell(raw, m.coborrower);
  return {
    errors,
    warnings,
    lead: {
      first_name: first,
      last_name: last,
      full_name_raw: full,
      phone_raw: phoneRaw,
      phone_e164: phone.value,
      phone2_raw: phone2Raw,
      phone2_e164: phone2.value,
      email: cell(raw, m.email),
      lender: cell(raw, m.lender),
      loan_amount_cents: loan.value,
      loan_amount_raw: loanRaw,
      age: age.value,
      age_raw: ageRaw,
      coborrower_raw: coRaw,
      coborrower_signal: coborrowerSignal(coRaw),
      address_line: cell(raw, m.address),
      city: cell(raw, m.city),
      state: st.value,
      zip: zip.value,
      time_zone: st.value ? STATE_TZ[st.value]!.tz : null,
      tobacco_raw: cell(raw, m.tobacco),
      health_heart_raw: cell(raw, m.health_heart),
      health_stroke_raw: cell(raw, m.health_stroke),
      health_cancer_raw: cell(raw, m.health_cancer),
      health_diabetes_raw: cell(raw, m.health_diabetes),
      extra,
    },
  };
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

export function analyzeSheet(db: DB, sheet: ParsedSheet, mapping: ColumnMapping, opts: ImportOptions = {}): RowResult[] {
  const mErr = validateMapping(mapping, sheet.headers);
  if (mErr.length) throw new MappingError(mErr);

  const existingFp = db.prepare("SELECT 1 FROM import_row WHERE row_fingerprint = ? AND status = 'accepted' LIMIT 1");
  const samePhone = db.prepare('SELECT id FROM lead WHERE phone_e164 = ? ORDER BY created_at');
  const seenFp = new Set<string>();
  const seenPhoneInFile = new Map<string, number>();

  return sheet.rows.map(({ rowNumber, cells }) => {
    const { lead, errors, warnings } = mapRow(cells, mapping);
    const fingerprint = rowFingerprint(lead);
    let status: RowStatus = 'accepted';
    if (errors.length) status = 'rejected';
    else if (seenFp.has(fingerprint)) {
      status = 'duplicate_in_file';
      warnings.push('identical to an earlier row in this file');
    } else if (existingFp.get(fingerprint) && !opts.importRepeatsAsNew) {
      status = 'already_imported';
      warnings.push('identical lead was already imported');
    }
    seenFp.add(fingerprint);

    let samePhoneLeadIds: string[] = [];
    if (lead.phone_e164 && status === 'accepted') {
      samePhoneLeadIds = (samePhone.all(lead.phone_e164) as { id: string }[]).map((r) => r.id);
      if (samePhoneLeadIds.length) warnings.push(`same phone as ${samePhoneLeadIds.length} existing lead(s); will be linked as a possible duplicate`);
      const prev = seenPhoneInFile.get(lead.phone_e164);
      if (prev) warnings.push(`same phone as row ${prev} in this file (co-borrowers often share a phone)`);
      else seenPhoneInFile.set(lead.phone_e164, rowNumber);
    }
    return { rowNumber, status, errors, warnings, fingerprint, lead, raw: cells, samePhoneLeadIds };
  });
}

export function deadPilePhones(db: DB): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT l.phone_e164 p FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE s.status = 'dead' AND l.phone_e164 IS NOT NULL")
    .all() as { p: string }[];
  return new Set(rows.map((r) => r.p));
}

export function previewImport(db: DB, sha256: string, sheet: ParsedSheet, mapping: ColumnMapping, opts: ImportOptions = {}) {
  const rows = analyzeSheet(db, sheet, mapping, opts);
  const dead = deadPilePhones(db);
  for (const r of rows) {
    if (r.status === 'accepted' && r.lead.phone_e164 && dead.has(r.lead.phone_e164)) {
      r.warnings.push('this phone number belongs to a lead in your dead pile');
    }
  }
  const summary: PreviewSummary = {
    total: rows.length,
    accepted: rows.filter((r) => r.status === 'accepted').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
    duplicate_in_file: rows.filter((r) => r.status === 'duplicate_in_file').length,
    already_imported: rows.filter((r) => r.status === 'already_imported').length,
    with_warnings: rows.filter((r) => r.warnings.length).length,
    possible_duplicates: rows.filter((r) => r.samePhoneLeadIds.length).length,
    in_dead_pile: rows.filter((r) => r.lead.phone_e164 && r.status === 'accepted' && dead.has(r.lead.phone_e164)).length,
    file_previously_imported: db
      .prepare('SELECT id batch_id, name, imported_at FROM import_batch WHERE file_sha256 = ? ORDER BY imported_at')
      .all(sha256) as PreviewSummary['file_previously_imported'],
  };
  return { summary, rows };
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

/** Writes the batch, every row (any status), the accepted leads, duplicate links and lead state, atomically. */
export function commitImport(
  db: DB,
  file: { fileName: string; sha256: string },
  sheet: ParsedSheet,
  mapping: ColumnMapping,
  batch: BatchInput,
  opts: ImportOptions = {},
) {
  if (!batch.name?.trim()) throw new MappingError(['batch name is required']);
  return db.transaction(() => {
    const { rows, summary } = previewImport(db, file.sha256, sheet, mapping, opts);
    if (summary.accepted === 0) {
      throw new MappingError(['no new leads to import: every row was rejected or already imported']);
    }
    const now = nowIso();
    const batchId = uuidv7();
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
      batch.purchased_count ?? null, batch.cost_total_cents ?? null, perLead, batch.lead_type ?? null,
      batch.lead_age_label ?? null, JSON.stringify({ sheet: sheet.name, headerRow: sheet.headerRow, mapping }), batch.notes ?? null,
    );
    const insRow = db.prepare(
      `INSERT INTO import_row (id, batch_id, row_number, raw_json, row_fingerprint, status, errors_json, warnings_json, lead_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const insLead = db.prepare(
      `INSERT INTO lead (id, batch_id, import_row_id, first_name, last_name, full_name_raw, phone_raw, phone_e164, phone_valid,
        phone2_raw, phone2_e164, email, lender, loan_amount_cents, loan_amount_raw, age, age_raw, coborrower_raw, coborrower_signal,
        address_line, city, state, zip, time_zone, tobacco_raw, health_heart_raw, health_stroke_raw, health_cancer_raw,
        health_diabetes_raw, extra_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insLink = db.prepare(
      `INSERT OR IGNORE INTO lead_link (id, lead_a, lead_b, reason, created_at) VALUES (?,?,?,'same_phone',?)`,
    );
    const newLeadIds: string[] = [];
    const phoneToNewLeads = new Map<string, string[]>();
    for (const r of rows) {
      const rowId = uuidv7();
      const leadId = r.status === 'accepted' ? uuidv7() : null;
      insRow.run(
        rowId, batchId, r.rowNumber, JSON.stringify(r.raw), r.fingerprint, r.status,
        r.errors.length ? JSON.stringify(r.errors) : null, r.warnings.length ? JSON.stringify(r.warnings) : null, leadId,
      );
      if (!leadId) continue;
      const l = r.lead;
      insLead.run(
        leadId, batchId, rowId, l.first_name, l.last_name, l.full_name_raw, l.phone_raw, l.phone_e164, l.phone_e164 ? 1 : 0,
        l.phone2_raw, l.phone2_e164, l.email, l.lender, l.loan_amount_cents, l.loan_amount_raw, l.age, l.age_raw,
        l.coborrower_raw, l.coborrower_signal, l.address_line, l.city, l.state, l.zip, l.time_zone, l.tobacco_raw,
        l.health_heart_raw, l.health_stroke_raw, l.health_cancer_raw, l.health_diabetes_raw,
        Object.keys(l.extra).length ? JSON.stringify(l.extra) : null, now,
      );
      newLeadIds.push(leadId);
      for (const other of r.samePhoneLeadIds) insLink.run(uuidv7(), other, leadId, now);
      if (l.phone_e164) {
        const list = phoneToNewLeads.get(l.phone_e164) ?? [];
        for (const other of list) insLink.run(uuidv7(), other, leadId, now);
        list.push(leadId);
        phoneToNewLeads.set(l.phone_e164, list);
      }
    }
    rebuildLeadState(db, newLeadIds);
    db.prepare(
      `INSERT INTO saved_mapping (id, name, header_key, mapping_json, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET header_key = excluded.header_key, mapping_json = excluded.mapping_json, updated_at = excluded.updated_at`,
    ).run(uuidv7(), `auto:${headerKey(sheet.headers)}`, headerKey(sheet.headers), JSON.stringify(mapping), now);
    return { batchId, summary, rows };
  })();
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
