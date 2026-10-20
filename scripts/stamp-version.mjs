// Sets package.json's version to <major>.<minor>.<n> for a release build (n = the CI run number).
import fs from 'node:fs';

const n = Number(process.argv[2]);
if (!Number.isInteger(n) || n < 1) throw new Error('usage: stamp-version.mjs <run number>');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const [major, minor] = pkg.version.split('.');
pkg.version = `${major}.${minor}.${n}`;
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
console.log(pkg.version);
