import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, ensureDirs, rotateToken } from './config.js';
import { openDatabase } from './db/connection.js';
import { createBackup, listBackups, restoreBackup, extractBackup, tableCounts, contentChecksum } from './backup.js';
import { rebuildLeadState, verifyLeadState } from './domain/leadState.js';
import Database from 'better-sqlite3';

const HELP = `Usage: npm run cli -- <command>

  backup                     Create a verified backup now
  backups                    List backups
  verify-backup <file>       Check a backup opens and passes the integrity check
  restore <file> [--identity <age key>]
                             Restore a backup (stop the app first; current DB is kept aside)
  rebuild                    Recompute derived lead state from the raw history
  verify                     Check derived lead state matches the raw history
  rotate-token               Make a new access link (old link stops working)
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const c = loadConfig();
  ensureDirs(c);
  switch (cmd) {
    case 'backup': {
      const db = openDatabase(c.dbFile);
      const r = await createBackup(db, c);
      db.close();
      console.log(`Backup written: ${r.file} (${r.bytes} bytes${r.encrypted ? ', encrypted' : ''})`);
      console.log(`Rows: ${Object.entries(r.counts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
      if (r.pruned.length) console.log(`Removed ${r.pruned.length} old backup(s).`);
      break;
    }
    case 'backups':
      for (const f of listBackups(c)) console.log(f);
      break;
    case 'verify-backup': {
      const file = need(args[0], 'backup file');
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-')), 'check.sqlite');
      const r = extractBackup(file, tmp, flag(args, '--identity'));
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
      console.log(`OK. checksum ${r.checksum}`);
      console.log(`Rows: ${Object.entries(r.counts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
      break;
    }
    case 'restore': {
      const file = need(args[0], 'backup file');
      const r = restoreBackup(c, path.resolve(file), flag(args, '--identity'));
      const db = new Database(c.dbFile, { readonly: true });
      const after = { counts: tableCounts(db), checksum: contentChecksum(db) };
      db.close();
      if (after.checksum !== r.checksum) throw new Error('restored database does not match the backup checksum');
      console.log(`Restored from ${r.restored_from}`);
      if (r.previous_database_kept_at) console.log(`Previous database kept at ${r.previous_database_kept_at}`);
      console.log(`Rows: ${Object.entries(after.counts).map(([t, n]) => `${t}=${n}`).join(' ')}`);
      break;
    }
    case 'rebuild': {
      const db = openDatabase(c.dbFile);
      console.log(`Rebuilt state for ${rebuildLeadState(db)} lead(s).`);
      db.close();
      break;
    }
    case 'verify': {
      const db = openDatabase(c.dbFile);
      const bad = verifyLeadState(db);
      db.close();
      if (bad.length) {
        console.log(`${bad.length} lead(s) differ from their history. Run "rebuild".`);
        process.exitCode = 2;
      } else console.log('Derived lead state matches the raw history.');
      break;
    }
    case 'rotate-token':
      rotateToken(c);
      console.log('New access token created. Restart the app to get the new link.');
      break;
    default:
      console.log(HELP);
      if (cmd) process.exitCode = 1;
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}\n\n${HELP}`);
  return v;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
