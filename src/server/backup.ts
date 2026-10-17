import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { DB } from './db/connection.js';
import type { Config } from './config.js';

// Backups use SQLite's online backup API, so they are consistent even while the app runs.
// Each backup is verified (integrity check + row counts) before it is kept.

export interface BackupResult {
  file: string;
  bytes: number;
  sha256: string;
  counts: Record<string, number>;
  encrypted: boolean;
  pruned: string[];
}

export function tableCounts(db: DB): Record<string, number> {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(names.map(({ name }) => [name, (db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get() as { n: number }).n]));
}

/** Order-independent checksum of every row in every table. Equal checksums mean equal contents. */
export function contentChecksum(db: DB): string {
  const h = createHash('sha256');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  for (const { name } of names) {
    const rows = (db.prepare(`SELECT * FROM "${name}"`).all() as unknown[]).map((r) => JSON.stringify(r)).sort();
    h.update(name);
    for (const r of rows) h.update(r);
  }
  return h.digest('hex');
}

function verifyFile(file: string) {
  // Backups are standalone files: switch them out of WAL mode so no -wal/-shm side files appear.
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('journal_mode = DELETE');
    const ok = db.pragma('integrity_check', { simple: true });
    if (ok !== 'ok') throw new Error(`integrity check failed: ${ok}`);
    return { counts: tableCounts(db), checksum: contentChecksum(db) };
  } finally {
    db.close();
  }
}

export async function createBackup(db: DB, c: Config, now = new Date()): Promise<BackupResult> {
  fs.mkdirSync(c.backupDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(c.backupDir, `.tmp-${stamp}.sqlite`);
  try {
    await db.backup(tmp);
    fs.chmodSync(tmp, 0o600);
    const live = { counts: tableCounts(db) };
    const copy = verifyFile(tmp);
    for (const [t, n] of Object.entries(live.counts)) {
      if (copy.counts[t] !== n) throw new Error(`backup row count mismatch on ${t}`);
    }
    let data = zlib.gzipSync(fs.readFileSync(tmp), { level: 9 });
    let file = path.join(c.backupDir, `crm-${stamp}.sqlite.gz`);
    let encrypted = false;
    if (c.backupAgeRecipient) {
      const r = spawnSync('age', ['-r', c.backupAgeRecipient], { input: data, maxBuffer: 1 << 30 });
      if (r.status !== 0) throw new Error(`age encryption failed: ${r.stderr?.toString() || r.error?.message}`);
      data = r.stdout;
      file += '.age';
      encrypted = true;
    }
    fs.writeFileSync(file, data, { mode: 0o600 });
    const meta = { file: path.basename(file), created_at: now.toISOString(), counts: copy.counts, checksum: copy.checksum };
    fs.writeFileSync(`${file}.json`, JSON.stringify(meta, null, 2), { mode: 0o600 });
    const pruned = pruneBackups(c);
    return { file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), counts: copy.counts, encrypted, pruned };
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
  }
}

export function listBackups(c: Config): string[] {
  if (!fs.existsSync(c.backupDir)) return [];
  return fs
    .readdirSync(c.backupDir)
    .filter((f) => /^crm-.*\.sqlite\.gz(\.age)?$/.test(f))
    .sort()
    .map((f) => path.join(c.backupDir, f));
}

function pruneBackups(c: Config): string[] {
  const all = listBackups(c);
  const old = all.slice(0, Math.max(0, all.length - c.backupKeep));
  for (const f of old) {
    fs.rmSync(f, { force: true });
    fs.rmSync(`${f}.json`, { force: true });
  }
  return old;
}

/** Decompresses (and decrypts, with an identity file) a backup into a plain SQLite file and verifies it. */
export function extractBackup(file: string, outFile: string, ageIdentity?: string) {
  let data = fs.readFileSync(file);
  if (file.endsWith('.age')) {
    if (!ageIdentity) throw new Error('this backup is encrypted; pass --identity <age key file>');
    const r = spawnSync('age', ['-d', '-i', ageIdentity], { input: data, maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error(`age decryption failed: ${r.stderr?.toString() || r.error?.message}`);
    data = r.stdout;
  }
  fs.writeFileSync(outFile, zlib.gunzipSync(data), { mode: 0o600 });
  return verifyFile(outFile);
}

/**
 * Restores a backup over the live database. The current database is moved aside, never deleted.
 * Must run while the app is stopped.
 */
export function restoreBackup(c: Config, file: string, ageIdentity?: string) {
  const pidFile = path.join(c.dataDir, 'server.pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (pid && isAlive(pid)) throw new Error(`the app is running (pid ${pid}); stop it before restoring`);
  }
  const staged = `${c.dbFile}.restore-staging`;
  const verified = extractBackup(file, staged, ageIdentity);
  let movedAside: string | null = null;
  if (fs.existsSync(c.dbFile)) {
    movedAside = `${c.dbFile}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(c.dbFile, movedAside);
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(c.dbFile + ext)) fs.renameSync(c.dbFile + ext, movedAside + ext);
    }
  }
  fs.renameSync(staged, c.dbFile);
  fs.chmodSync(c.dbFile, 0o600);
  return { restored_from: file, previous_database_kept_at: movedAside, ...verified };
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RestoreCheck {
  at: string;
  file: string | null;
  ok: boolean | null;
  message: string;
}

/**
 * Restores the newest backup into a scratch file and checks it opens cleanly and matches what was saved
 * (integrity check, row counts and contents). The live database is never touched. Encrypted backups are
 * skipped, since the key to open them isn't kept on this computer.
 */
export function checkLatestBackup(c: Config, now = new Date()): RestoreCheck {
  const at = now.toISOString();
  const file = listBackups(c).at(-1);
  if (!file) return { at, file: null, ok: null, message: 'No backups yet.' };
  const name = path.basename(file);
  if (file.endsWith('.age')) return { at, file: name, ok: null, message: 'Skipped: this backup is encrypted, so it can only be checked with your key.' };
  const scratch = path.join(c.backupDir, `.check-${at.replace(/[:.]/g, '-')}.sqlite`);
  try {
    const got = extractBackup(file, scratch);
    const metaFile = `${file}.json`;
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { counts?: Record<string, number>; checksum?: string };
      for (const [t, n] of Object.entries(meta.counts ?? {})) {
        if (got.counts[t] !== n) throw new Error(`table ${t} has ${got.counts[t] ?? 0} rows, expected ${n}`);
      }
      if (meta.checksum && meta.checksum !== got.checksum) throw new Error('the contents differ from when it was saved');
    }
    const rows = Object.values(got.counts).reduce((a, b) => a + b, 0);
    return { at, file: name, ok: true, message: `Restored cleanly into a scratch copy: ${rows} rows checked.` };
  } catch (e: any) {
    return { at, file: name, ok: false, message: `Restore check failed: ${e.message}` };
  } finally {
    for (const f of [scratch, `${scratch}-wal`, `${scratch}-shm`]) fs.rmSync(f, { force: true });
  }
}
