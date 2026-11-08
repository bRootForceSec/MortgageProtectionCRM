import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/http/app.js';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { matchingLeadIds, toLeadFilter } from '../../src/server/domain/callList.js';
import { deleteTag, ensureTag, listTags, renameTag, setTagForMatching, setTagOnLeads, tagLead } from '../../src/server/domain/tags.js';
import { LeadQuery } from '../../src/shared/leadFilter.js';
import { describeFilter } from '../../src/shared/leadFilter.js';
import type { DB } from '../../src/server/db/connection.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const auth = { host: '127.0.0.1:5170', cookie: `mpcrm_session=${TOKEN}` };
const write = { ...auth, origin: 'http://127.0.0.1:5170' };

let db: DB;
let app: FastifyInstance;
const lead = (first: string) => (db.prepare('SELECT id FROM lead WHERE first_name = ?').get(first) as { id: string }).id;
const matching = (q: Record<string, unknown>) => matchingLeadIds(db, toLeadFilter(LeadQuery.parse(q)));

beforeEach(async () => {
  const t = tempDb();
  db = t.db;
  const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
  const sheet = parsed.sheets[0]!;
  commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b1' });
  app = await buildApp({ db, config: t.c, token: TOKEN });
});

describe('tags', () => {
  it('one tag per name, whatever the case; rename refuses a name another tag has', () => {
    const a = ensureTag(db, '  Spanish ');
    expect(a.name).toBe('Spanish');
    expect(ensureTag(db, 'spanish').id).toBe(a.id);
    const b = ensureTag(db, 'Friday');
    expect(() => renameTag(db, b.id, 'SPANISH')).toThrow(/already a tag/);
    expect(renameTag(db, b.id, 'Friday list').name).toBe('Friday list');
    expect(() => ensureTag(db, '   ')).toThrow(/name/);
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE table_name = 'tag'").get()).toEqual({ n: 3 });
  });

  it('tags a lead, keeps it in the change history, and filters leads by tag or no tags', () => {
    const jane = lead('Jane');
    const ann = lead('Ann');
    expect(tagLead(db, jane, 'Spanish').map((t) => t.name)).toEqual(['Spanish']);
    tagLead(db, jane, 'spanish'); // already has it
    const tag = listTags(db)[0]!;
    expect(tag).toMatchObject({ name: 'Spanish', leads: 1 });
    expect(matching({ tag: tag.id })).toEqual([jane]);
    expect(matching({ tag: 'none' })).not.toContain(jane);
    expect(matching({ tag: 'none' })).toContain(ann);
    expect(db.prepare('SELECT kind, tag_name, source FROM lead_event WHERE lead_id = ?').all(jane)).toEqual([{ kind: 'tag_added', tag_name: 'Spanish', source: 'you' }]);
    expect(setTagOnLeads(db, [jane], tag.id, false)).toBe(1);
    expect(matching({ tag: tag.id })).toEqual([]);
  });

  it('tags every lead matching the filters, then takes it off again', () => {
    const all = matching({});
    const r = setTagForMatching(db, toLeadFilter(LeadQuery.parse({})), 'Friday', true);
    expect(r).toMatchObject({ changed: all.length, matched: all.length, tag: { name: 'Friday' } });
    expect(setTagForMatching(db, toLeadFilter(LeadQuery.parse({})), 'friday', true).changed).toBe(0);
    expect(setTagForMatching(db, toLeadFilter(LeadQuery.parse({})), 'Friday', false).changed).toBe(all.length);
    expect(() => setTagForMatching(db, toLeadFilter(LeadQuery.parse({})), 'Nope', false)).toThrow(/no tag/);
  });

  it('deleting a tag takes it off every lead', () => {
    const jane = lead('Jane');
    const t = ensureTag(db, 'Spouse decides');
    setTagOnLeads(db, [jane], t.id, true);
    expect(deleteTag(db, t.id)).toEqual({ removed_from: 1 });
    expect(listTags(db)).toEqual([]);
    expect(matching({ tag: t.id })).toEqual([]);
  });

  it('routine steps describe a tag filter by name', () => {
    expect(describeFilter({ status: 'all', tag: 't1' }, { tag: (id) => (id === 't1' ? 'Spanish' : undefined) })).toBe('All leads · Tagged "Spanish"');
    expect(describeFilter({ status: 'all', tag: 'gone' }, { tag: () => undefined })).toContain('a deleted tag');
    expect(describeFilter({ status: 'all', tag: 'none' })).toContain('No tags');
  });

  it('routes: tag a lead, see it on the lead and in Leads, tag matching, rename, delete', async () => {
    const jane = lead('Jane');
    const add = await app.inject({ method: 'POST', url: `/api/leads/${jane}/tags`, headers: write, payload: { name: 'Spanish' } });
    expect(add.statusCode).toBe(200);
    const [tag] = add.json() as { id: string; name: string }[];
    expect((await app.inject({ url: `/api/leads/${jane}`, headers: auth })).json().tags).toEqual([tag]);
    const leads = (await app.inject({ url: `/api/leads?tag=${tag!.id}`, headers: auth })).json();
    expect(leads.total).toBe(1);
    expect(leads.rows[0]).toMatchObject({ id: jane, tags: ['Spanish'] });
    const untagged = (await app.inject({ url: '/api/leads', headers: auth })).json().rows.find((r: { id: string }) => r.id !== jane);
    expect(untagged.tags).toEqual([]);

    const m = await app.inject({ method: 'POST', url: '/api/leads/tag-matching', headers: write, payload: { search: 'Ann', tag_name: 'Friday' } });
    expect(m.json()).toMatchObject({ changed: 1, matched: 1 });

    const ren = await app.inject({ method: 'PUT', url: `/api/tags/${tag!.id}`, headers: write, payload: { name: 'Habla español' } });
    expect(ren.json().name).toBe('Habla español');
    const off = await app.inject({ method: 'DELETE', url: `/api/leads/${jane}/tags/${tag!.id}`, headers: write });
    expect(off.json()).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/tags/${tag!.id}`, headers: write })).json()).toEqual({ removed_from: 0 });
    expect((await app.inject({ url: '/api/tags', headers: auth })).json().map((t: { name: string }) => t.name)).toEqual(['Friday']);
  });
});
