import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../db/connection.js';
import { nowIso } from '../ids.js';
import { countyKey } from './county.js';
import { getSetting, setSetting } from '../core/settings.js';
import { audit } from '../core/audit.js';

// Built-in area codes for each county, by state (data/county-area-codes.json). When a county first gets leads,
// it's linked to these codes so area-code picking works without setup. You can change the links in Settings;
// a county is filled in only once, so your changes stick. To add a state, add its counties to the data file.

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = [path.resolve(here, '../data/county-area-codes.json'), path.resolve(here, '../../../src/server/data/county-area-codes.json')].find((f) =>
  fs.existsSync(f),
);

let index: Map<string, string[]> | null = null;

function load(): Map<string, string[]> {
  if (index) return index;
  index = new Map();
  if (!DATA_FILE) return index;
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as { states: Record<string, Record<string, string[]>> };
  for (const [state, counties] of Object.entries(raw.states)) {
    for (const [county, codes] of Object.entries(counties)) index.set(countyKey(state, county), codes);
  }
  return index;
}

/** Built-in area codes for a county key like "IN|ALLEN", or [] when the state isn't in the table yet. */
export function builtInAreaCodes(key: string): string[] {
  return load().get(key) ?? [];
}

export function builtInStates(): string[] {
  return [...new Set([...load().keys()].map((k) => k.split('|')[0]!))].sort();
}

const SEEDED = 'area_codes_seeded';

/** Links counties that have leads but no area codes yet to their built-in codes. Each county only once. */
export function seedCountyAreaCodes(db: DB): number {
  const seeded = new Set(getSetting<string[]>(db, SEEDED) ?? []);
  const keys = (
    db
      .prepare(
        `SELECT DISTINCT county_key FROM lead WHERE county_key IS NOT NULL
         AND county_key NOT IN (SELECT county_key FROM county_area_code)`,
      )
      .all() as { county_key: string }[]
  ).map((r) => r.county_key).filter((k) => !seeded.has(k));
  if (!keys.length) return 0;
  let linked = 0;
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO county_area_code (county_key, area_code, created_at) VALUES (?,?,?)');
    const now = nowIso();
    for (const k of keys) {
      const codes = builtInAreaCodes(k);
      if (!codes.length) continue; // state not in the table yet: try again once it is
      for (const c of codes) ins.run(k, c, now);
      audit(db, 'county_area_code', k, 'built_in', null, codes, now);
      seeded.add(k);
      linked++;
    }
    setSetting(db, SEEDED, [...seeded]);
  })();
  return linked;
}
