import fs from 'node:fs';
import type { DB } from './db/connection.js';
import type { Config } from './config.js';
import { createBackup, listBackups } from './backup.js';

// Nightly backup run by the desktop app itself (the Linux service uses a systemd timer instead).
// Same rules as that timer: 11:30 PM every night, and straight after start-up if a night was missed.

export const BACKUP_HOUR = 23;
export const BACKUP_MINUTE = 30;
const DAY_MS = 24 * 3600_000;

/** The next 11:30 PM (local time) after `now`. */
export function nextBackupTime(now: Date): Date {
  const t = new Date(now);
  t.setHours(BACKUP_HOUR, BACKUP_MINUTE, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

/** True when there is no backup from the last 24 hours. */
export function backupOverdue(lastBackup: Date | null, now: Date): boolean {
  return !lastBackup || now.getTime() - lastBackup.getTime() > DAY_MS;
}

export function newestBackupTime(c: Config): Date | null {
  const newest = listBackups(c).at(-1);
  if (!newest) return null;
  try {
    return fs.statSync(newest).mtime;
  } catch {
    return null;
  }
}

export interface BackupScheduler {
  stop(): void;
}

/** Starts the nightly backup. `log` gets one line per backup or failure. */
export function scheduleBackups(db: DB, c: Config, log: (msg: string) => void, catchUpDelayMs = 2 * 60_000): BackupScheduler {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const run = async () => {
    try {
      const r = await createBackup(db, c);
      log(`Backup written: ${r.file}`);
    } catch (e: any) {
      log(`Nightly backup failed: ${e.message}`);
    }
  };
  const planNext = () => {
    if (stopped) return;
    // Re-planned after every run, so sleep, clock changes and daylight saving don't drift it.
    const wait = nextBackupTime(new Date()).getTime() - Date.now();
    timer = setTimeout(async () => {
      await run();
      planNext();
    }, Math.max(wait, 1000));
    timer.unref?.();
  };
  if (backupOverdue(newestBackupTime(c), new Date())) {
    timer = setTimeout(async () => {
      await run();
      planNext();
    }, catchUpDelayMs);
    timer.unref?.();
  } else {
    planNext();
  }
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
