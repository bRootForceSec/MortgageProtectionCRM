import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tempConfig, tempDb, sampleCsv, SAMPLE_HEADERS } from '../helpers.js';
import { migrate } from '../../src/server/db/connection.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport, mapFields } from '../../src/server/domain/importer.js';
import { exportRows } from '../../src/server/domain/exporter.js';
import { uuidv7 } from '../../src/server/ids.js';

describe('migration 018', () => {
  it('moves the alternate and called-in-from numbers into the list, in order', () => {
    const c = tempConfig();
    const old = path.join(c.dataDir, 'old-migrations');
    fs.mkdirSync(old);
    const src = path.resolve('src/server/db/migrations');
    for (const f of fs.readdirSync(src).filter((f) => f < '018')) fs.copyFileSync(path.join(src, f), path.join(old, f));
    const d = new Database(c.dbFile);
    d.pragma('foreign_keys = ON');
    migrate(d, old);
    const now = new Date().toISOString();
    const b = uuidv7();
    d.prepare("INSERT INTO import_batch (id, name, source, file_name, file_sha256, imported_at, column_mapping_json) VALUES (?, 'b', 'x', 'f', 's', ?, '{}')").run(b, now);
    const lead = (name: string, p2: [string | null, string | null], p3: [string | null, string | null]) => {
      const r = uuidv7(), l = uuidv7();
      d.prepare("INSERT INTO import_row (id, batch_id, row_number, raw_json, row_fingerprint, status) VALUES (?, ?, 1, '{}', ?, 'accepted')").run(r, b, r);
      d.prepare(
        `INSERT INTO lead (id, batch_id, import_row_id, first_name, phone_e164, phone_valid, phone2_raw, phone2_e164, phone3_raw, phone3_e164, coborrower_signal, created_at)
         VALUES (?, ?, ?, ?, '+13175550100', 1, ?, ?, ?, ?, 'unknown', ?)`,
      ).run(l, b, r, name, ...p2, ...p3, now);
      return l;
    };
    const both = lead('Both', ['317-555-0102', '+13175550102'], ['317-555-0103', '+13175550103']);
    const onlyThird = lead('Third', [null, null], ['317-555-0104', '+13175550104']);
    const badSecond = lead('Bad', ['555-01', null], [null, null]);
    lead('None', [null, null], [null, null]);
    migrate(d, src);
    expect(d.prepare('SELECT lead_id, pos, raw, e164, label FROM lead_other_phone ORDER BY lead_id, pos').all()).toEqual([
      { lead_id: both, pos: 1, raw: '317-555-0102', e164: '+13175550102', label: 'Alternate' },
      { lead_id: both, pos: 2, raw: '317-555-0103', e164: '+13175550103', label: 'Called in from' },
      { lead_id: onlyThird, pos: 1, raw: '317-555-0104', e164: '+13175550104', label: 'Called in from' },
      { lead_id: badSecond, pos: 1, raw: '555-01', e164: null, label: 'Alternate' },
    ].sort((a, b) => a.lead_id.localeCompare(b.lead_id) || a.pos - b.pos));
    const cols = (d.prepare('PRAGMA table_info(lead)').all() as { name: string }[]).map((x) => x.name);
    expect(cols).not.toContain('phone2_e164');
    expect(cols).not.toContain('phone3_raw');
    expect((d.prepare("SELECT lead_id FROM lead_number WHERE e164 = '+13175550103'").all() as any[]).map((x) => x.lead_id)).toEqual([both]);
    expect(d.pragma('foreign_key_check')).toEqual([]);
    d.close();
    // Runs every migration twice over a file database: slow on Windows CI runners (33s seen), so it gets more time.
  }, 90_000);
});

describe('importing several numbers', () => {
  it('keeps every number in a cell, drops repeats, and warns about a bad one', () => {
    const { lead, errors, warnings } = mapFields({
      full_name: 'Pat Many',
      phone: '317-555-0110 / 317-555-0111',
      phone2: '317-555-0112, 317-555-0110 or 317-555-0113',
      phone3: '317-555-01',
    });
    expect(errors).toEqual([]);
    expect(lead.phone_e164).toBe('+13175550110');
    expect(lead.other_phones).toEqual([
      { raw: '317-555-0111', e164: '+13175550111', label: null },
      { raw: '317-555-0112', e164: '+13175550112', label: 'Alternate' },
      { raw: '317-555-0113', e164: '+13175550113', label: 'Alternate' },
      { raw: '317-555-01', e164: null, label: 'Called in from' },
    ]);
    expect(warnings).toEqual([expect.stringMatching(/^third phone is not 10 digits/)]);
  });

  it('a sheet with an extra phone column gives the lead a list, shown in exports', async () => {
    const { db } = tempDb();
    const headers = [...SAMPLE_HEADERS, 'Alt Phone'];
    const parsed = await parseSpreadsheet(
      sampleCsv([['Pat Many', '317-555-0120', 'Chase', 1, 50, '', '', 'Carmel', 'IN', '46032', '', '', '', '', '', '', '317-555-0121; 317-555-0122']], headers),
      'many.csv',
    );
    const sheet = parsed.sheets[0]!;
    commitImport(db, parsed, sheet, suggestMapping(sheet.headers), { name: 'b' });
    const id = (db.prepare("SELECT id FROM lead WHERE first_name = 'Pat'").get() as any).id;
    expect((db.prepare('SELECT e164 FROM lead_other_phone WHERE lead_id = ? ORDER BY pos').all(id) as any[]).map((x) => x.e164)).toEqual(['+13175550121', '+13175550122']);
    expect(exportRows(db, 'leads')[0]).toMatchObject({ phone_e164: '+13175550120', other_phones: 'Alternate: +13175550121; Alternate: +13175550122' });
  });
});
