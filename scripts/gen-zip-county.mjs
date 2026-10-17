// Regenerates src/server/data/zip-county.json from the GeoNames US postal code file.
//   node scripts/gen-zip-county.mjs path/to/US.txt
// Source: GeoNames (https://download.geonames.org/export/zip/US.zip), CC BY 4.0.
// Output: { "46619": "IN|St. Joseph|South Bend", ... }  (state | county | place)
import fs from 'node:fs';

const src = process.argv[2];
if (!src) throw new Error('usage: node scripts/gen-zip-county.mjs US.txt');
const out = {};
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  const f = line.split('\t');
  if (f[0] !== 'US' || !/^\d{5}$/.test(f[1] ?? '') || !f[4] || !f[5]) continue;
  out[f[1]] = `${f[4]}|${f[5]}|${f[2]}`;
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync('src/server/data/zip-county.json', JSON.stringify(sorted));
console.log(`${Object.keys(sorted).length} ZIP codes written`);
