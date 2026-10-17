// Writes dist/build-info.json so the running app knows which version it is.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

let commit = process.env.MPCRM_COMMIT || '';
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    commit = 'dev';
  }
}
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/build-info.json', JSON.stringify({ commit, built_at: new Date().toISOString() }, null, 2));
