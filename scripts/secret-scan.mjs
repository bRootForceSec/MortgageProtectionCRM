// Fails if anything that looks like a credential is in tracked files or the built browser bundle.
// Plan test T16. Kept dependency-free so it runs anywhere.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PATTERNS = [
  [/KEY0[0-9A-F]{20,}_[A-Za-z0-9]{10,}/, 'Telnyx API key'],
  [/\bSK[0-9a-fA-F]{32}\b/, 'Twilio API key'],
  [/\bAC[0-9a-fA-F]{32}\b/, 'Twilio account SID'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/AGE-SECRET-KEY-1[0-9A-Z]{20,}/, 'age secret key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
];

const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const built = fs.existsSync('dist/web') ? walk('dist/web') : [];
let bad = 0;
for (const f of [...tracked, ...built]) {
  if (f === 'scripts/secret-scan.mjs' || !fs.existsSync(f) || fs.statSync(f).size > 5_000_000) continue;
  const text = fs.readFileSync(f, 'utf8');
  for (const [re, what] of PATTERNS) {
    if (re.test(text)) {
      console.error(`Possible ${what} in ${f}`);
      bad++;
    }
  }
}
if (!built.length) console.warn('dist/web not found; run "npm run build" to scan the browser bundle too.');
console.log(bad ? `${bad} finding(s).` : `No secrets found in ${tracked.length} tracked and ${built.length} built files.`);
process.exit(bad ? 1 : 0);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
