#!/usr/bin/env node
// Keeps known shortcuts from spreading. Each rule has a per-file allowance equal to what the code had when
// the rule was added. A file may go below its allowance (then lower the number here) but never above, and
// files not listed get zero. See CLAUDE.md for where the code should go instead.
import fs from 'node:fs';
import path from 'node:path';

const RULES = [
  {
    name: 'SQL in a route file (move the query into src/server/domain/)',
    dir: 'src/server/http',
    pattern: /\.prepare\(/g,
    allow: {},
  },
  {
    name: 'silent .catch(() => {}) in the UI (show or log the failure, or comment why it is harmless)',
    dir: 'src/web',
    pattern: /\.catch\(\(\) => \{\}\)(?![^\n]*\/\/)/g,
    allow: {},
  },
  {
    name: 'hand-written audit_log insert (use audit() from src/server/core/audit.ts)',
    dir: 'src/server',
    pattern: /INSERT INTO audit_log/g,
    allow: { 'core/audit.ts': 1 },
  },
  {
    name: 'console.* in server code (use the pino logger)',
    dir: 'src/server',
    pattern: /\bconsole\.(log|warn|error|info|debug)\(/g,
    // cli.ts is a command-line tool and prints to the terminal on purpose. config.ts and main.ts report problems
    // from before the logger exists. updates.ts reports a desktop install that fails after the server has stopped.
    allow: { 'cli.ts': Infinity, 'config.ts': 2, 'updates.ts': 1, 'main.ts': 1 },
  },
];

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });

let failed = false;
for (const rule of RULES) {
  for (const file of walk(rule.dir)) {
    const rel = path.relative(rule.dir, file).split(path.sep).join('/');
    const count = (fs.readFileSync(file, 'utf8').match(rule.pattern) ?? []).length;
    const allowed = rule.allow[rel] ?? 0;
    if (count > allowed) {
      failed = true;
      console.error(`${path.join(rule.dir, rel)}: ${count} × ${rule.name} (allowed ${allowed})`);
    } else if (count < allowed && allowed !== Infinity) {
      console.log(`${path.join(rule.dir, rel)}: now ${count} × ${rule.name}; lower its allowance in scripts/check-structure.mjs from ${allowed} to ${count}`);
    }
  }
}
if (failed) {
  console.error('\nNew code should use the shared pieces described in CLAUDE.md instead.');
  process.exit(1);
}
console.log('Structure check passed.');
