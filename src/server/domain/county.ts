import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// County lookup. Leads are grouped by the county they were bought for, never by their phone's area code.
// Order: county printed on the lead → ZIP code → city + state. ZIP data: GeoNames (CC BY 4.0).

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = [path.resolve(here, '../data/zip-county.json'), path.resolve(here, '../../../src/server/data/zip-county.json')].find((f) =>
  fs.existsSync(f),
);

interface ZipEntry {
  state: string;
  county: string;
  place: string;
}

let zipIndex: Map<string, ZipEntry> | null = null;
let countyIndex: Map<string, string> | null = null; // "IN|ST JOSEPH" -> "St. Joseph"
let placeIndex: Map<string, Set<string>> | null = null; // "IN|SOUTH BEND" -> county keys

function load() {
  if (zipIndex) return;
  zipIndex = new Map();
  countyIndex = new Map();
  placeIndex = new Map();
  if (!DATA_FILE) return;
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as Record<string, string>;
  for (const [zip, v] of Object.entries(raw)) {
    const [state, county, place] = v.split('|') as [string, string, string];
    zipIndex.set(zip, { state, county, place });
    const key = countyKey(state, county);
    countyIndex.set(key, county);
    const pk = `${state}|${normWord(place)}`;
    if (!placeIndex.has(pk)) placeIndex.set(pk, new Set());
    placeIndex.get(pk)!.add(key);
  }
}

function normWord(s: string) {
  return s.toUpperCase().replace(/[.']/g, '').replace(/\s+/g, ' ').trim();
}

/** "St. Joseph County" / "ST JOSEPH" / "Saint Joseph" -> "ST JOSEPH". */
export function normalizeCountyName(name: string): string {
  return normWord(name)
    .replace(/\b(COUNTY|PARISH|BOROUGH|CENSUS AREA|CITY AND BOROUGH|MUNICIPALITY)\b/g, '')
    .replace(/\bSAINT\b/g, 'ST')
    .replace(/\bSAINTE\b/g, 'STE')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countyKey(state: string, county: string): string {
  return `${state.toUpperCase()}|${normalizeCountyName(county)}`;
}

export interface CountyResult {
  key: string;
  name: string;
  state: string;
  source: 'page' | 'zip' | 'city' | 'manual';
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Display name for a county key, from the reference data when known. */
export function countyDisplayName(key: string): string {
  load();
  const known = countyIndex!.get(key);
  if (known) return known;
  return titleCase(key.split('|')[1] ?? key);
}

export function lookupZip(zip: string | null | undefined): ZipEntry | null {
  if (!zip) return null;
  load();
  return zipIndex!.get(zip.slice(0, 5)) ?? null;
}

/**
 * Finds the county for a lead. A county printed on the lead wins; it is checked against the
 * reference list for its state so "ALLEN COUNTY" and "Allen" end up in the same group.
 */
export function resolveCounty(input: { county?: string | null; state?: string | null; zip?: string | null; city?: string | null }): CountyResult | null {
  load();
  const zipHit = lookupZip(input.zip);
  const state = (input.state || zipHit?.state || '').toUpperCase() || null;
  if (input.county && normalizeCountyName(input.county)) {
    if (!state) return null; // can't tell which state's county this is
    const key = countyKey(state, input.county);
    return { key, name: countyDisplayName(key), state, source: 'page' };
  }
  if (zipHit && (!state || zipHit.state === state)) {
    const key = countyKey(zipHit.state, zipHit.county);
    return { key, name: zipHit.county, state: zipHit.state, source: 'zip' };
  }
  if (input.city && state) {
    const keys = placeIndex!.get(`${state}|${normWord(input.city)}`);
    if (keys && keys.size === 1) {
      const key = [...keys][0]!;
      return { key, name: countyDisplayName(key), state, source: 'city' };
    }
  }
  return null;
}

/** True when the county name is in the reference list for that state (used to flag typos for review). */
export function isKnownCounty(key: string): boolean {
  load();
  return countyIndex!.size === 0 || countyIndex!.has(key);
}
