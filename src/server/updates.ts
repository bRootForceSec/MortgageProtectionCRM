import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Reads the updater's state files (scripts/mpcrm-update.mjs) and asks systemd to run it.
// When the app was started by hand (npm start / npm run dev) there is no MPCRM_APP_DIR and updates are "not managed".

export interface BuildInfo {
  commit: string;
  built_at: string | null;
}

export interface UpdateStatus {
  managed: boolean;
  current: BuildInfo;
  staged: { commit: string; from: string | null; changes: string[]; at: string } | null;
  last_check: { ok: boolean; error?: string; latest?: string; at: string } | null;
  last_apply: { ok: boolean; from: string | null; to: string; error?: string; rolled_back?: boolean; changes?: string[]; at: string } | null;
}

export type Runner = (unit: string) => Promise<void>;

/** Starts a systemd user unit without waiting for it to finish. */
export const systemdRunner: Runner = (unit) =>
  new Promise((resolve, reject) => {
    const child = spawn('systemctl', ['--user', 'start', '--no-block', unit], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `systemctl exited with ${code}`))));
  });

export function readBuildInfo(file: string): BuildInfo {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { commit: String(j.commit || 'dev'), built_at: j.built_at ?? null };
  } catch {
    return { commit: 'dev', built_at: null };
  }
}

function readJson<T>(f: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  } catch {
    return null;
  }
}

export class Updates {
  constructor(
    private appDir: string | null,
    readonly build: BuildInfo,
    private run: Runner = systemdRunner,
  ) {}

  get managed() {
    return this.appDir !== null;
  }

  status(): UpdateStatus {
    if (!this.appDir) return { managed: false, current: this.build, staged: null, last_check: null, last_apply: null };
    const s = (n: string) => path.join(this.appDir!, 'state', `${n}.json`);
    const staged = readJson<UpdateStatus['staged']>(s('staged'));
    return {
      managed: true,
      current: this.build,
      // A staged version equal to the running one has just been installed.
      staged: staged && staged.commit !== this.build.commit ? staged : null,
      last_check: readJson(s('check')),
      last_apply: readJson(s('apply')),
    };
  }

  async apply() {
    if (!this.appDir) throw new Error('updates are not set up on this copy (it was started by hand)');
    if (!this.status().staged) throw new Error('there is no update ready to install');
    await this.run('mpcrm-apply.service');
  }

  async check() {
    if (!this.appDir) throw new Error('updates are not set up on this copy (it was started by hand)');
    await this.run('mpcrm-update.service');
  }
}
