import type { DB } from '../db/connection.js';
import { LEAD_NAME } from '../db/sql.js';
import { uuidv7, nowIso } from '../ids.js';
import { audit } from '../core/audit.js';
import { DomainError } from '../core/errors.js';
import { getSetting, setSetting } from '../core/settings.js';
import { normalizeUsPhone } from './normalize.js';
import { findLead } from './unitrustAppointments.js';
import { commissionCents, hasRules, policyStage, type PolicyStage, type ProductKind } from '../../shared/policies.js';

// Policies read off the Unitrust Business Management Report by the Firefox extension, the products they're for, and
// your Unitrust comp level over time. Each policy is keyed by its Unitrust app number and matched to a lead by the
// client's phone (then name). A carrier + product the CRM hasn't seen is added with no rules, and its policies count
// for nothing until you set them (Settings → Products and comp).

/** One policy as the extension read it: text as the page shows it. */
export interface RawPolicy {
  app_id: string;
  policy_number?: string | null;
  client_name?: string | null;
  client_phone?: string | null;
  carrier: string;
  product: string;
  premium?: string | null;
  apv?: string | null;
  capped_apv?: string | null;
  status?: string | null;
  applied?: string | null;
  submitted?: string | null;
  paid?: string | null;
  lapsed?: string | null;
}

export interface PolicySync {
  at: string;
  seen: number;
  added: number;
  changed: number;
  matched: number;
  /** Client names of policies with no lead in the CRM. */
  unmatched: string[];
  /** Products added by this sync, "CARRIER / Product". */
  new_products: string[];
  /** Products (any, not just new) still missing a rule. */
  needs_rules: number;
  /** Your comp level as the page showed it, when it did. */
  level: number | null;
  /** Statuses the CRM doesn't recognize (counted as pending). */
  unknown_statuses: string[];
}

const SETTING = 'unitrust_policy_sync';

export function lastPolicySync(db: DB): PolicySync | null {
  return getSetting<PolicySync>(db, SETTING);
}

/** "$1,036.68" → 103668 cents; null when there's no number. */
export function parseMoney(s: string | null | undefined): number | null {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(s ?? '');
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** "11/03/2026" (or already "2026-11-03") → "2026-11-03"; null for "—" or anything else. */
export function parseDay(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (!us) return null;
  const y = us[3]!.length === 2 ? `20${us[3]}` : us[3]!;
  return `${y}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
}

const clean = (s: string | null | undefined) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t && t !== '—' && t !== '-' ? t : null;
};

/** Stores what the extension read off the report. Returns what it found. */
export function recordUnitrustPolicies(db: DB, input: { policies: RawPolicy[]; level?: number | null; today?: string }, now = nowIso()): PolicySync {
  const today = input.today ?? now.slice(0, 10);
  const sync: PolicySync = { at: now, seen: 0, added: 0, changed: 0, matched: 0, unmatched: [], new_products: [], needs_rules: 0, level: input.level ?? null, unknown_statuses: [] };
  const productByName = db.prepare('SELECT id FROM product WHERE upper(carrier) = upper(?) AND upper(name) = upper(?)');
  const insertProduct = db.prepare('INSERT INTO product (id, carrier, name, created_at, updated_at) VALUES (?,?,?,?,?)');
  const byApp = db.prepare('SELECT * FROM policy WHERE unitrust_app_id = ?');
  const insertPolicy = db.prepare(
    `INSERT INTO policy (id, unitrust_app_id, policy_number, product_id, lead_id, lead_linked_by, client_name, client_phone_e164,
                         premium_cents, apv_cents, capped_apv_cents, status, applied_on, submitted_on, paid_on, lapsed_on, first_seen_at, updated_at)
     VALUES (@id, @unitrust_app_id, @policy_number, @product_id, @lead_id, @lead_linked_by, @client_name, @client_phone_e164,
             @premium_cents, @apv_cents, @capped_apv_cents, @status, @applied_on, @submitted_on, @paid_on, @lapsed_on, @first_seen_at, @updated_at)`,
  );
  const unknown = new Set<string>();

  db.transaction(() => {
    if (input.level != null && input.level !== currentLevel(db)) {
      addLevel(db, input.level, today, 'unitrust', now);
    }
    const seen = new Set<string>();
    for (const raw of input.policies) {
      const appId = clean(raw.app_id);
      const carrier = clean(raw.carrier);
      const productName = clean(raw.product);
      if (!appId || !carrier || !productName || seen.has(appId)) continue;
      seen.add(appId);
      sync.seen++;

      let productId = (productByName.get(carrier, productName) as { id: string } | undefined)?.id;
      if (!productId) {
        productId = uuidv7();
        insertProduct.run(productId, carrier, productName, now, now);
        audit(db, 'product', productId, 'insert', null, { carrier, name: productName }, now);
        sync.new_products.push(`${carrier} / ${productName}`);
      }

      const status = clean(raw.status);
      const st = policyStage(status);
      if (status && !st.known) unknown.add(status);
      const submitted = parseDay(raw.submitted);
      const old = byApp.get(appId) as PolicyRecord | undefined;
      const phone = normalizeUsPhone(clean(raw.client_phone) ?? '').value;
      const fields = {
        policy_number: clean(raw.policy_number) ?? old?.policy_number ?? null,
        product_id: productId,
        client_name: clean(raw.client_name) ?? old?.client_name ?? null,
        client_phone_e164: phone ?? old?.client_phone_e164 ?? null,
        premium_cents: parseMoney(raw.premium) ?? old?.premium_cents ?? null,
        apv_cents: parseMoney(raw.apv) ?? old?.apv_cents ?? null,
        capped_apv_cents: parseMoney(raw.capped_apv) ?? old?.capped_apv_cents ?? null,
        status: status ?? old?.status ?? null,
        applied_on: parseDay(raw.applied) ?? old?.applied_on ?? submitted,
        submitted_on: submitted ?? old?.submitted_on ?? null,
        // The list view has no Paid date: the first day it's seen paid stands in until the card view gives the real one.
        paid_on: parseDay(raw.paid) ?? old?.paid_on ?? (st.stage === 'paid' ? today : null),
        lapsed_on: parseDay(raw.lapsed) ?? old?.lapsed_on ?? null,
      };

      // A lead linked by hand stays; otherwise keep trying until one matches.
      let leadId = old?.lead_id ?? null;
      let linkedBy = old?.lead_linked_by ?? null;
      if (!leadId && linkedBy !== 'manual') {
        leadId = findLead(db, (fields.client_phone_e164 ?? '').replace(/^\+1/, ''), fields.client_name ?? '');
        if (leadId) linkedBy = 'auto';
      }
      if (leadId) sync.matched++;
      else sync.unmatched.push(fields.client_name ?? appId);

      if (!old) {
        const id = uuidv7();
        const row = { id, unitrust_app_id: appId, ...fields, lead_id: leadId, lead_linked_by: linkedBy, first_seen_at: now, updated_at: now };
        insertPolicy.run(row);
        audit(db, 'policy', id, 'insert', null, row, now);
        sync.added++;
        continue;
      }
      const next = { ...fields, lead_id: leadId, lead_linked_by: linkedBy };
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => old[k] !== next[k]);
      if (!changed.length) continue;
      db.prepare(`UPDATE policy SET ${changed.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @updated_at WHERE id = @id`)
        .run({ ...Object.fromEntries(changed.map((k) => [k, next[k]])), updated_at: now, id: old.id });
      audit(db, 'policy', old.id, 'update', Object.fromEntries(changed.map((k) => [k, old[k]])), Object.fromEntries(changed.map((k) => [k, next[k]])), now);
      sync.changed++;
    }
    sync.unmatched = sync.unmatched.slice(0, 100);
    sync.needs_rules = productsNeedingRules(db);
    sync.unknown_statuses = [...unknown];
    setSetting(db, SETTING, sync);
  })();
  return sync;
}

interface PolicyRecord {
  id: string;
  unitrust_app_id: string;
  policy_number: string | null;
  product_id: string;
  lead_id: string | null;
  lead_linked_by: 'auto' | 'manual' | null;
  client_name: string | null;
  client_phone_e164: string | null;
  premium_cents: number | null;
  apv_cents: number | null;
  capped_apv_cents: number | null;
  status: string | null;
  applied_on: string | null;
  submitted_on: string | null;
  paid_on: string | null;
  lapsed_on: string | null;
  first_seen_at: string;
  updated_at: string;
}

// ---------- comp level ----------

export interface CompLevel {
  id: string;
  level: number;
  effective_from: string;
  source: 'unitrust' | 'manual';
  created_at: string;
}

export function compLevels(db: DB): CompLevel[] {
  return db.prepare('SELECT * FROM comp_level ORDER BY effective_from, created_at').all() as CompLevel[];
}

/** The level in effect on a day: the newest one from that day or before, else the oldest one you have. */
export function levelOn(levels: CompLevel[], day: string | null): number | null {
  if (!levels.length) return null;
  let found: CompLevel | null = null;
  for (const l of levels) if (day && l.effective_from <= day) found = l;
  return (found ?? levels[0]!).level;
}

function currentLevel(db: DB): number | null {
  return levelOn(compLevels(db), '9999-12-31');
}

function addLevel(db: DB, level: number, from: string, source: CompLevel['source'], now: string) {
  const id = uuidv7();
  const row = { id, level, effective_from: from, source, created_at: now };
  db.prepare('INSERT INTO comp_level (id, level, effective_from, source, created_at) VALUES (@id, @level, @effective_from, @source, @created_at)').run(row);
  audit(db, 'comp_level', id, 'insert', null, row, now);
}

/** Sets your comp level from a day on (Settings). */
export function setCompLevel(db: DB, level: number, from: string, now = nowIso()) {
  if (!parseDay(from)) throw new DomainError('pick the day this level started');
  db.transaction(() => addLevel(db, level, parseDay(from)!, 'manual', now))();
  return compLevels(db);
}

export function deleteCompLevel(db: DB, id: string, now = nowIso()) {
  db.transaction(() => {
    const old = db.prepare('SELECT * FROM comp_level WHERE id = ?').get(id);
    if (!old) throw new DomainError('that comp level is already gone', 404);
    db.prepare('DELETE FROM comp_level WHERE id = ?').run(id);
    audit(db, 'comp_level', id, 'delete', old, null, now);
  })();
  return compLevels(db);
}

// ---------- products ----------

export interface Product {
  id: string;
  carrier: string;
  name: string;
  kind: ProductKind | null;
  comp_hit_points: number | null;
  advance_pct: number | null;
  /** How many policies are for it. */
  policies: number;
  needs_rules: boolean;
}

export function listProducts(db: DB): Product[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.carrier, p.name, p.kind, p.comp_hit_points, p.advance_pct, (SELECT count(*) FROM policy x WHERE x.product_id = p.id) policies
       FROM product p ORDER BY upper(p.carrier), upper(p.name)`,
    )
    .all() as Omit<Product, 'needs_rules'>[];
  return rows.map((p) => ({ ...p, needs_rules: !hasRules(p) }));
}

export function productsNeedingRules(db: DB): number {
  return (db.prepare('SELECT count(*) n FROM product WHERE comp_hit_points IS NULL OR advance_pct IS NULL').get() as { n: number }).n;
}

export interface ProductPatch {
  kind?: ProductKind | null;
  comp_hit_points?: number | null;
  advance_pct?: number | null;
}

export function saveProduct(db: DB, id: string, patch: ProductPatch, now = nowIso()): Product {
  db.transaction(() => {
    const old = db.prepare('SELECT kind, comp_hit_points, advance_pct FROM product WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!old) throw new DomainError('no such product', 404);
    const keys = (['kind', 'comp_hit_points', 'advance_pct'] as const).filter((k) => k in patch && patch[k] !== old[k]);
    if (!keys.length) return;
    db.prepare(`UPDATE product SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`)
      .run({ ...Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])), now, id });
    audit(db, 'product', id, 'update', Object.fromEntries(keys.map((k) => [k, old[k]])), Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])), now);
  })();
  return listProducts(db).find((p) => p.id === id)!;
}

// ---------- policies with their commission ----------

export interface PolicyView {
  id: string;
  unitrust_app_id: string;
  policy_number: string | null;
  lead_id: string | null;
  lead_name: string | null;
  lead_linked_by: 'auto' | 'manual' | null;
  client_name: string | null;
  carrier: string;
  product: string;
  product_id: string;
  kind: ProductKind | null;
  status: string | null;
  stage: PolicyStage;
  premium_cents: number | null;
  /** Capped APV, or APV when capped is blank: what comp is paid on. */
  ap_cents: number | null;
  applied_on: string | null;
  paid_on: string | null;
  lapsed_on: string | null;
  /** Your comp level on the application day. */
  level: number | null;
  comp_hit_points: number | null;
  advance_pct: number | null;
  /** The advance, or null when a rule or your level isn't set. */
  commission_cents: number | null;
}

/** Policies with their commission, optionally only one lead's or only the ones with no lead. */
export function listPolicies(db: DB, only: { leadId?: string; unlinked?: boolean } = {}): PolicyView[] {
  const where = only.leadId ? 'x.lead_id = @lead' : only.unlinked ? 'x.lead_id IS NULL' : '1';
  const rows = db
    .prepare(
      `SELECT x.id, x.unitrust_app_id, x.policy_number, x.lead_id, x.lead_linked_by, x.client_name, x.status, x.premium_cents,
              coalesce(x.capped_apv_cents, x.apv_cents) ap_cents, x.applied_on, x.submitted_on, x.paid_on, x.lapsed_on,
              p.id product_id, p.carrier, p.name product, p.kind, p.comp_hit_points, p.advance_pct,
              CASE WHEN l.id IS NOT NULL THEN ${LEAD_NAME} END lead_name
       FROM policy x JOIN product p ON p.id = x.product_id LEFT JOIN lead l ON l.id = x.lead_id
       WHERE ${where}
       ORDER BY coalesce(x.applied_on, x.submitted_on, substr(x.first_seen_at, 1, 10)) DESC, x.unitrust_app_id DESC`,
    )
    .all(only.leadId ? { lead: only.leadId } : {}) as (Omit<PolicyView, 'stage' | 'level' | 'commission_cents'> & { submitted_on: string | null })[];
  const levels = compLevels(db);
  return rows.map(({ submitted_on, ...r }) => {
    const level = levelOn(levels, r.applied_on ?? submitted_on);
    return { ...r, stage: policyStage(r.status).stage, level, commission_cents: commissionCents(r.ap_cents, level, r) };
  });
}

/** Links a policy to a lead by hand (or unlinks it with null). A sync never changes a link made here. */
export function linkPolicy(db: DB, policyId: string, leadId: string | null, now = nowIso()) {
  db.transaction(() => {
    const old = db.prepare('SELECT lead_id, lead_linked_by FROM policy WHERE id = ?').get(policyId) as { lead_id: string | null; lead_linked_by: string | null } | undefined;
    if (!old) throw new DomainError('no such policy', 404);
    if (leadId && !db.prepare('SELECT 1 FROM lead WHERE id = ?').get(leadId)) throw new DomainError('no such lead', 404);
    db.prepare("UPDATE policy SET lead_id = ?, lead_linked_by = 'manual', updated_at = ? WHERE id = ?").run(leadId, now, policyId);
    audit(db, 'policy', policyId, 'link', old, { lead_id: leadId, lead_linked_by: 'manual' }, now);
  })();
}

/** What each lead's policies add up to: paid commission, and the pending estimate. For Reports. */
export function commissionByLead(policies: PolicyView[]): Map<string, { commission: number; pending: number }> {
  const out = new Map<string, { commission: number; pending: number }>();
  for (const p of policies) {
    if (!p.lead_id || p.commission_cents == null || p.stage === 'out') continue;
    const m = out.get(p.lead_id) ?? { commission: 0, pending: 0 };
    if (p.stage === 'paid') m.commission += p.commission_cents;
    else m.pending += p.commission_cents;
    out.set(p.lead_id, m);
  }
  return out;
}

export function hasPolicies(db: DB): boolean {
  return !!db.prepare('SELECT 1 FROM policy LIMIT 1').get();
}
