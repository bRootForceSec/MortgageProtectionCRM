import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import {
  linkPolicy, listPolicies, listProducts, productsNeedingRules, recordUnitrustPolicies, saveProduct, setCompLevel, type RawPolicy,
} from '../../src/server/domain/policies.js';
import { buildReport } from '../../src/server/domain/reports.js';
import { buildApp } from '../../src/server/http/app.js';
import type { DB } from '../../src/server/db/connection.js';
import type { Config } from '../../src/server/config.js';

let db: DB;
let config: Config;
const id = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;

// As the extension reads List View: Robert Ray (614-555-0102) bought an Americo Term 100.
const robertPolicy = (over: Partial<RawPolicy> = {}): RawPolicy => ({
  app_id: 'Uni-100001', policy_number: 'TEST000001', client_name: 'Robert Ray', client_phone: '(614) 555-0102',
  carrier: 'AMERICO', product: 'Term 100', premium: '$55.29', apv: '$663.48', capped_apv: '$663.48', status: 'Issue-Paid', submitted: '11/03/2026',
  ...over,
});

beforeEach(async () => {
  ({ db, c: config } = tempDb());
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1', cost_per_lead_cents: 2900 });
});

describe('policies from the Business Management Report', () => {
  it('a new carrier + product is added with no rules, and its policies count for nothing until they are set', () => {
    const s = recordUnitrustPolicies(db, { policies: [robertPolicy()], level: 70, today: '2026-11-04' });
    expect(s).toMatchObject({ seen: 1, added: 1, matched: 1, unmatched: [], new_products: ['AMERICO / Term 100'], needs_rules: 1, level: 70 });
    expect(productsNeedingRules(db)).toBe(1);
    const [p] = listPolicies(db, { leadId: id('Robert') });
    expect(p).toMatchObject({ stage: 'paid', ap_cents: 66348, level: 70, commission_cents: null, applied_on: '2026-11-03', paid_on: '2026-11-04' });

    const product = listProducts(db)[0]!;
    expect(product).toMatchObject({ carrier: 'AMERICO', name: 'Term 100', kind: null, comp_hit_points: null, advance_pct: null, needs_rules: true, policies: 1 });
    saveProduct(db, product.id, { kind: 'term', comp_hit_points: 10, advance_pct: 75 });
    expect(productsNeedingRules(db)).toBe(0);
    // $663.48 × (70 − 10)% × 75%
    expect(listPolicies(db)[0]!.commission_cents).toBe(29857);
  });

  it('reading the page again only changes what changed, and a status change is recorded', () => {
    recordUnitrustPolicies(db, { policies: [robertPolicy({ status: 'Issued Not Paid' })], today: '2026-11-03' });
    expect(listPolicies(db)[0]).toMatchObject({ stage: 'pending', paid_on: null });
    expect(recordUnitrustPolicies(db, { policies: [robertPolicy({ status: 'Issued Not Paid' })] })).toMatchObject({ added: 0, changed: 0 });
    expect(recordUnitrustPolicies(db, { policies: [robertPolicy()], today: '2026-11-05' })).toMatchObject({ added: 0, changed: 1 });
    expect(listPolicies(db)[0]).toMatchObject({ stage: 'paid', paid_on: '2026-11-05' });
    const audits = db.prepare("SELECT action FROM audit_log WHERE table_name = 'policy'").all() as { action: string }[];
    expect(audits.map((a) => a.action)).toEqual(['insert', 'update']);
  });

  it('each policy keeps the level from its application day; a new level on the page starts from that day', () => {
    recordUnitrustPolicies(db, { policies: [robertPolicy()], level: 70, today: '2026-11-04' });
    recordUnitrustPolicies(db, { policies: [robertPolicy({ app_id: 'Uni-600000', submitted: '12/02/2026' })], level: 75, today: '2026-12-01' });
    const product = listProducts(db)[0]!;
    saveProduct(db, product.id, { comp_hit_points: 10, advance_pct: 75 });
    const byApp = Object.fromEntries(listPolicies(db).map((p) => [p.unitrust_app_id, p]));
    expect(byApp['Uni-100001']).toMatchObject({ level: 70, commission_cents: 29857 });
    expect(byApp['Uni-600000']).toMatchObject({ level: 75 });
    // A level set in Settings from an earlier day changes the policies applied for after it.
    setCompLevel(db, 80, '2026-11-01');
    expect(listPolicies(db).find((p) => p.unitrust_app_id === 'Uni-100001')!.level).toBe(80);
  });

  it('a policy with no lead can be linked by hand, and a sync never undoes that', () => {
    recordUnitrustPolicies(db, { policies: [robertPolicy({ client_name: 'Referral Person', client_phone: '(999) 555-1234' })] });
    const [p] = listPolicies(db, { unlinked: true });
    expect(p!.lead_id).toBeNull();
    linkPolicy(db, p!.id, id('Ann'));
    recordUnitrustPolicies(db, { policies: [robertPolicy({ client_name: 'Referral Person', client_phone: '(999) 555-1234' })] });
    expect(listPolicies(db, { leadId: id('Ann') })).toHaveLength(1);
    // Unlinked by hand: stays unlinked even though a phone would match.
    linkPolicy(db, p!.id, null);
    recordUnitrustPolicies(db, { policies: [robertPolicy()] });
    expect(listPolicies(db, { unlinked: true })).toHaveLength(1);
  });

  it('Reports: commission and net by batch and lead type, and profit for the dates', () => {
    recordUnitrustPolicies(db, { policies: [robertPolicy(), robertPolicy({ app_id: 'Uni-1', client_name: 'Nobody', client_phone: '(999) 555-1234', status: 'Submitted' })], level: 70, today: '2026-11-04' });
    const product = listProducts(db)[0]!;
    saveProduct(db, product.id, { comp_hit_points: 10, advance_pct: 75 });
    const r = buildReport(db, { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z', tz: 'UTC' });
    const b = r.by_batch[0]!;
    expect(b.commission).toBe(29857);
    expect(b.net).toBe(29857 - b.cost);
    expect(r.profit).toMatchObject({ commission: 29857, paid_policies: 1, pending_policies: 1, missing_rules: 0, no_lead: 0 });
    expect(r.profit!.net).toBe(29857 - r.profit!.lead_spend);
    expect(r.profit!.lead_spend).toBe(b.cost);
    // Outside the dates: nothing paid.
    const early = buildReport(db, { from: '2000-01-01T00:00:00.000Z', to: '2001-01-01T00:00:00.000Z', tz: 'UTC' });
    expect(early.profit).toMatchObject({ commission: 0, lead_spend: 0, paid_policies: 0 });
  });

  it('the extension posts policies with its own key; Settings sees products and the banner count', async () => {
    const app: FastifyInstance = await buildApp({ db, config, token: 'test-token-0123456789abcdef0123456789abcdef' });
    const HOST = '127.0.0.1:5170';
    const auth = { host: HOST, cookie: 'mpcrm_session=test-token-0123456789abcdef0123456789abcdef' };
    const { key } = (await app.inject({ method: 'POST', url: '/api/unitrust/key', headers: { ...auth, origin: `http://${HOST}` } })).json();
    const ext = { host: HOST, origin: 'moz-extension://abc', 'x-mpcrm-extension-key': key };
    const ok = await app.inject({ method: 'POST', url: '/api/unitrust/policies', headers: ext, payload: { policies: [robertPolicy()], level: 70 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ seen: 1, needs_rules: 1 });
    const wrong = await app.inject({ method: 'POST', url: '/api/unitrust/policies', headers: { ...ext, 'x-mpcrm-extension-key': 'nope' }, payload: { policies: [] } });
    expect(wrong.statusCode).toBe(401);
    expect((await app.inject({ url: '/api/meta', headers: auth })).json().products_need_rules).toBe(1);
    const { products, levels } = (await app.inject({ url: '/api/products', headers: auth })).json();
    expect(levels).toHaveLength(1);
    const put = await app.inject({
      method: 'PUT', url: `/api/products/${products[0].id}`, headers: { ...auth, origin: `http://${HOST}` }, payload: { kind: 'term', comp_hit_points: 10, advance_pct: 75 },
    });
    expect(put.json()).toMatchObject({ needs_rules: false });
    const mine = (await app.inject({ url: `/api/policies?lead=${id('Robert')}`, headers: auth })).json();
    expect(mine.policies[0].commission_cents).toBe(29857);
  });
});
