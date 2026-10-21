import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../db/connection.js';
import { nowIso } from '../ids.js';
import { countyKey, countyDisplayName } from './county.js';
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

/** Counties with leads (and any with area codes set), with lead counts, their area codes and the built-in ones. */
export function listCounties(db: DB) {
  seedCountyAreaCodes(db);
  const rows = db
    .prepare(
      `SELECT l.county_key, max(l.county) county, max(l.state) state, COUNT(*) leads,
              SUM(CASE WHEN s.status IN ('new','retry','callback') THEN 1 ELSE 0 END) workable
       FROM lead l JOIN lead_state s ON s.lead_id = l.id WHERE l.county_key IS NOT NULL GROUP BY l.county_key ORDER BY state, county`,
    )
    .all() as { county_key: string; county: string; state: string; leads: number; workable: number }[];
  const codes = db.prepare('SELECT county_key, area_code FROM county_area_code ORDER BY area_code').all() as { county_key: string; area_code: string }[];
  const known = new Set(rows.map((r) => r.county_key));
  const extra = [...new Set(codes.map((c) => c.county_key))].filter((k) => !known.has(k));
  return [
    ...rows.map((r) => ({
      ...r,
      name: countyDisplayName(r.county_key),
      area_codes: codes.filter((c) => c.county_key === r.county_key).map((c) => c.area_code),
      // The county's built-in area codes (from the county's location, never the leads' own numbers).
      built_in: builtInAreaCodes(r.county_key),
    })),
    ...extra.map((k) => ({
      county_key: k, county: countyDisplayName(k), name: countyDisplayName(k), state: k.split('|')[0], leads: 0, workable: 0,
      area_codes: codes.filter((c) => c.county_key === k).map((c) => c.area_code), built_in: builtInAreaCodes(k),
    })),
  ];
}

/** Replaces a county's area codes. */
export function setCountyAreaCodes(db: DB, key: string, areaCodes: string[]) {
  const now = nowIso();
  db.transaction(() => {
    const old = (db.prepare('SELECT area_code FROM county_area_code WHERE county_key = ?').all(key) as { area_code: string }[]).map((r) => r.area_code);
    db.prepare('DELETE FROM county_area_code WHERE county_key = ?').run(key);
    const ins = db.prepare('INSERT OR IGNORE INTO county_area_code (county_key, area_code, created_at) VALUES (?,?,?)');
    for (const c of areaCodes) ins.run(key, c, now);
    audit(db, 'county_area_code', key, 'set', old, areaCodes, now);
  })();
}
