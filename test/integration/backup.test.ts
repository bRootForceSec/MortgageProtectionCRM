import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { tempDb, sampleCsv } from '../helpers.js';
import { parseSpreadsheet } from '../../src/server/domain/spreadsheet.js';
import { suggestMapping } from '../../src/server/domain/mapping.js';
import { commitImport } from '../../src/server/domain/importer.js';
import { logManualCall } from '../../src/server/domain/calls.js';
import { createBackup, restoreBackup, contentChecksum, tableCounts, listBackups } from '../../src/server/backup.js';
import { openDatabase } from '../../src/server/db/connection.js';

describe('backup and restore', () => {
  it('T14: a backup restores to identical contents, and the old database is kept aside', async () => {
    const { c, db } = tempDb();
    const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
    commitImport(db, parsed, parsed.sheets[0]!, suggestMapping(parsed.sheets[0]!.headers), { name: 'b1' });
    const lead = (db.prepare('SELECT id FROM lead LIMIT 1').get() as any).id;
    logManualCall(db, { lead_id: lead, idempotency_key: 'k-12345678', outcome_code: 'vm_left' });
    const original = { counts: tableCounts(db), checksum: contentChecksum(db) };

    const b = await createBackup(db, c);
    expect(fs.statSync(b.file).mode & 0o777).toBe(0o600);

    // Data changes after the backup are rolled back by the restore.
    logManualCall(db, { lead_id: lead, idempotency_key: 'k-87654321', outcome_code: 'busy' });
    db.close();

    const r = restoreBackup(c, b.file);
    expect(r.checksum).toBe(original.checksum);
    expect(r.previous_database_kept_at && fs.existsSync(r.previous_database_kept_at)).toBeTruthy();
    const restored = new Database(c.dbFile, { readonly: true });
    expect(tableCounts(restored)).toEqual(original.counts);
    expect(contentChecksum(restored)).toBe(original.checksum);
    restored.close();
    // The restored file opens normally through the app path (migrations are a no-op).
    openDatabase(c.dbFile).close();
  });

  it('keeps only the configured number of backups', async () => {
    const { c, db } = tempDb();
    for (let i = 0; i < 5; i++) await createBackup(db, c, new Date(Date.UTC(2026, 9, 1 + i)));
    expect(listBackups(c)).toHaveLength(c.backupKeep);
  });

  it('refuses to restore while the app is running', async () => {
    const { c, db } = tempDb();
    const b = await createBackup(db, c);
    fs.writeFileSync(`${c.dataDir}/server.pid`, String(process.pid));
    expect(() => restoreBackup(c, b.file)).toThrow(/stop it before restoring/);
  });

  it('T9 groundwork: committed data survives closing and reopening the database', async () => {
    const { c, db } = tempDb();
    const parsed = await parseSpreadsheet(sampleCsv(), 'a.csv');
    commitImport(db, parsed, parsed.sheets[0]!, suggestMapping(parsed.sheets[0]!.headers), { name: 'b1' });
    const lead = (db.prepare('SELECT id FROM lead LIMIT 1').get() as any).id;
    logManualCall(db, { lead_id: lead, idempotency_key: 'k-12345678', outcome_code: 'vm_left' });
    db.close();
    const again = openDatabase(c.dbFile);
    expect((again.prepare('SELECT COUNT(*) n FROM call').get() as any).n).toBe(1);
  });
});
