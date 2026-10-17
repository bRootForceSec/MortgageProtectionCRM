import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { nowIso } from '../ids.js';

// Which AI reads scanned pages. Plain settings live in the database (they are exported with it);
// API keys live in a separate 0600 file in the data folder and are never sent to the browser.

export const AiSettings = z.object({
  provider: z.enum(['claude_code', 'anthropic_api', 'openai_compatible', 'off']).default('claude_code'),
  claude_code: z
    .object({
      command: z.string().min(1).max(500).default('claude'),
      model: z.string().min(1).max(100).default('haiku'),
    })
    .default({ command: 'claude', model: 'haiku' }),
  anthropic_api: z.object({ model: z.string().min(1).max(100).default('claude-haiku-5-5') }).default({ model: 'claude-haiku-5-5' }),
  openai_compatible: z
    .object({
      base_url: z.string().max(500).default('http://127.0.0.1:11434/v1'),
      model: z.string().max(100).default(''),
    })
    .default({ base_url: 'http://127.0.0.1:11434/v1', model: '' }),
});
export type AiSettings = z.infer<typeof AiSettings>;

export function getSetting<T>(db: DB, key: string): T | null {
  const r = db.prepare('SELECT value_json FROM app_setting WHERE key = ?').get(key) as { value_json: string } | undefined;
  return r ? (JSON.parse(r.value_json) as T) : null;
}

export function setSetting(db: DB, key: string, value: unknown) {
  db.prepare(
    `INSERT INTO app_setting (key, value_json, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowIso());
}

export function loadAiSettings(db: DB): AiSettings {
  return AiSettings.parse(getSetting(db, 'ai') ?? {});
}

export function saveAiSettings(db: DB, input: unknown): AiSettings {
  const s = AiSettings.parse(input);
  setSetting(db, 'ai', s);
  return s;
}

export type SecretName = 'anthropic_api_key' | 'openai_api_key' | 'google_client_secret' | 'google_refresh_token';

export class Secrets {
  constructor(private file: string) {}
  static inDataDir(dataDir: string) {
    return new Secrets(path.join(dataDir, 'secrets.json'));
  }
  private read(): Partial<Record<SecretName, string>> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }
  get(name: SecretName): string | null {
    return this.read()[name] || null;
  }
  /** Saves a key, or removes it when value is empty. */
  set(name: SecretName, value: string | null) {
    const all = this.read();
    if (value) all[name] = value.trim();
    else delete all[name];
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
  /** Which keys are saved, without their values. */
  present(): Record<'anthropic_api_key' | 'openai_api_key', boolean> {
    const all = this.read();
    return { anthropic_api_key: !!all.anthropic_api_key, openai_api_key: !!all.openai_api_key };
  }
}
