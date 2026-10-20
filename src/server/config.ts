import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

// All settings come from environment variables (or a 0600 env file loaded by the start script).
// Nothing machine-specific is hard-coded beyond the default data folder for each system.

export interface Config {
  dataDir: string;
  dbFile: string;
  backupDir: string;
  importsDir: string;
  host: string;
  port: number;
  backupKeep: number;
  backupAgeRecipient: string | null;
}

/**
 * Where the data folder is when MPCRM_DATA_DIR isn't set.
 * Windows and Mac: "Mortgage CRM" in your home folder (not Documents or Desktop, which are often synced to the cloud).
 * Linux: still ~/.local/share/mpcrm, which the systemd install and its scripts expect, until installs move to the desktop app.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (platform === 'win32' || platform === 'darwin') return path.join(home, 'Mortgage CRM');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'mpcrm');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.MPCRM_DATA_DIR || defaultDataDir(env));
  const port = Number(env.MPCRM_PORT || 5170);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MPCRM_PORT must be 1024-65535');
  return {
    dataDir,
    dbFile: path.join(dataDir, 'crm.sqlite'),
    backupDir: path.resolve(env.MPCRM_BACKUP_DIR || path.join(dataDir, 'backups')),
    importsDir: path.join(dataDir, 'imports'),
    // Deliberately loopback only. Exposing the UI to the network needs authentication first (plan §9.9).
    host: '127.0.0.1',
    port,
    backupKeep: Number(env.MPCRM_BACKUP_KEEP || 30),
    backupAgeRecipient: env.MPCRM_BACKUP_AGE_RECIPIENT || null,
  };
}

export function ensureDirs(c: Config) {
  for (const d of [c.dataDir, c.backupDir, c.importsDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
}

/** Per-install access token. Stored 0600; required on every API request (via cookie). */
export function loadOrCreateToken(c: Config): string {
  const f = path.join(c.dataDir, 'access-token');
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(32).toString('base64url');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

export function rotateToken(c: Config): string {
  fs.rmSync(path.join(c.dataDir, 'access-token'), { force: true });
  return loadOrCreateToken(c);
}
