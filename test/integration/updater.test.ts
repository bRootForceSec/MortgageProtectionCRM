import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';

// Drives scripts/mpcrm-update.mjs against a throwaway git repo whose "app" is a tiny HTTP server,
// with a fake `systemctl` that starts and stops it. Checks: bootstrap, check → staged, apply,
// a version that fails to build, and a version that fails to start (rolled back, data restored).

const UPDATER = path.resolve('scripts/mpcrm-update.mjs');

const FAKE_MAIN = `
import http from 'node:http';
import fs from 'node:fs';
const info = JSON.parse(fs.readFileSync(new URL('../build-info.json', import.meta.url)));
if (fs.existsSync(new URL('../../CRASH', import.meta.url))) {
  // A broken version that changes the data (like a migration) and then dies.
  fs.writeFileSync(process.env.MPCRM_DATA_DIR + '/crm.txt', 'changed by the broken version');
  process.exit(1);
}
http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, commit: info.commit }));
}).listen(Number(process.env.MPCRM_PORT), '127.0.0.1');
`;

// Fake cli: "backup" copies the data file; "restore <file>" copies it back.
const FAKE_CLI = `
import fs from 'node:fs';
import path from 'node:path';
const [cmd, file] = process.argv.slice(2);
const data = path.join(process.env.MPCRM_DATA_DIR, 'crm.txt');
if (cmd === 'backup') {
  const out = path.join(process.env.MPCRM_DATA_DIR, 'backup-' + Date.now() + '.txt');
  fs.copyFileSync(data, out);
  console.log('Backup written: ' + out + ' (10 bytes)');
} else if (cmd === 'restore') {
  fs.copyFileSync(file, data);
  console.log('Restored from ' + file);
}
`;

const BUILD = `set -e
test -f BREAK_BUILD && exit 1
mkdir -p dist/server
cp app/main.mjs dist/server/main.js
cp app/cli.mjs dist/server/cli.js
printf '{"commit":"%s"}' "$MPCRM_COMMIT" > dist/build-info.json
`;

// Fake systemctl --user start|stop|restart <unit>: runs the current release's main.js in the background.
const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
shift # --user
cmd="$1"; unit="$2"
pidf="$MPCRM_APP_DIR/fake.pid"
stop() { if [ -f "$pidf" ]; then kill "$(cat "$pidf")" 2>/dev/null || true; rm -f "$pidf"; sleep 0.2; fi; }
start() { (cd "$MPCRM_APP_DIR/current" && exec node dist/server/main.js) </dev/null >/dev/null 2>&1 & echo $! > "$pidf"; }
case "$cmd" in
  stop) stop ;;
  start) start ;;
  restart) stop; start ;;
esac
`;

// Ignore the machine's git config (commit signing, hooks) so the test is self-contained.
const HERMETIC_GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

let root: string;
let src: string;
let app: string;
let data: string;
let env: NodeJS.ProcessEnv;

function sh(cwd: string, cmd: string) {
  return execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, ...HERMETIC_GIT, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

function commit(msg: string, files: Record<string, string | null>) {
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(src, f);
    if (c === null) fs.rmSync(p, { force: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c);
    }
  }
  sh(src, `git add -A && git commit -qm "${msg}"`);
  return sh(src, 'git rev-parse HEAD');
}

function run(cmd: string) {
  return spawnSync(process.execPath, [UPDATER, cmd], { env, encoding: 'utf8' });
}

const state = (n: string) => JSON.parse(fs.readFileSync(path.join(app, 'state', `${n}.json`), 'utf8'));
const current = () => path.basename(fs.readlinkSync(path.join(app, 'current')));

async function freePort() {
  return new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-upd-'));
  src = path.join(root, 'src');
  app = path.join(root, 'app');
  data = path.join(root, 'data');
  fs.mkdirSync(src);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'crm.txt'), 'v1 data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
  sh(src, 'git init -q -b main');
  commit('first version', { 'app/main.mjs': FAKE_MAIN, 'app/cli.mjs': FAKE_CLI, 'build.sh': BUILD });
  fs.mkdirSync(app);
  sh(root, `git clone -q "${src}" "${app}/repo"`);
  env = {
    ...process.env,
    ...HERMETIC_GIT,
    PATH: `${bin}:${process.env.PATH}`,
    MPCRM_APP_DIR: app,
    MPCRM_DATA_DIR: data,
    MPCRM_PORT: String(await freePort()),
    MPCRM_UPDATE_BUILD_CMD: 'sh build.sh',
    MPCRM_UPDATE_BRANCH: 'main',
    MPCRM_SERVICE: 'mpcrm.service',
    MPCRM_HEALTH_TIMEOUT_MS: '8000',
  };
});

afterAll(() => {
  spawnSync(path.join(root, 'bin', 'systemctl'), ['--user', 'stop', 'mpcrm.service'], { env });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('self-updater', () => {
  it('bootstrap builds the latest version and makes it current', () => {
    const r = run('bootstrap');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(current()).toBe(sh(src, 'git rev-parse HEAD'));
    spawnSync(path.join(root, 'bin', 'systemctl'), ['--user', 'start', 'mpcrm.service'], { env });
  });

  it('check does nothing when already up to date', () => {
    expect(run('check').status).toBe(0);
    expect(fs.existsSync(path.join(app, 'state', 'staged.json'))).toBe(false);
    expect(state('check').ok).toBe(true);
  });

  it('check prepares a newer version without switching to it; apply backs up, switches and restarts', async () => {
    const before = current();
    const next = commit('Add the dial counter', { 'NOTES.md': 'x' });
    expect(run('check').status).toBe(0);
    const staged = state('staged');
    expect(staged.commit).toBe(next);
    expect(staged.changes).toEqual(['Add the dial counter']);
    expect(current()).toBe(before); // still running the old one

    const r = run('apply');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(current()).toBe(next);
    expect(path.basename(fs.readlinkSync(path.join(app, 'previous')))).toBe(before);
    expect(state('apply')).toMatchObject({ ok: true, from: before, to: next });
    expect(state('apply').backup).toMatch(/backup-\d+\.txt$/);
    expect(fs.existsSync(path.join(app, 'state', 'staged.json'))).toBe(false);
    const health = await (await fetch(`http://127.0.0.1:${env.MPCRM_PORT}/healthz`)).json();
    expect(health.commit).toBe(next);
  });

  it('a version that fails to build is never offered, and is not rebuilt every hour', () => {
    const before = current();
    const bad = commit('broken build', { BREAK_BUILD: '1' });
    expect(run('check').status).toBe(1);
    expect(state('check')).toMatchObject({ ok: false, failed_commit: bad });
    expect(fs.existsSync(path.join(app, 'state', 'staged.json'))).toBe(false);
    expect(run('check').status).toBe(0); // skipped, same failed commit
    expect(current()).toBe(before);
    commit('fix build', { BREAK_BUILD: null });
  });

  it('a version that does not start is rolled back, with the data restored to just before the update', async () => {
    expect(run('check').status).toBe(0);
    const good = current();
    run('apply'); // install the build fix first
    const before = current();
    expect(before).not.toBe(good);

    const crashing = commit('crashes on start', { CRASH: '1' });
    expect(run('check').status).toBe(0);
    fs.writeFileSync(path.join(data, 'crm.txt'), 'data before the update');
    const r = run('apply');
    expect(r.status).toBe(1);
    expect(current()).toBe(before);
    const a = state('apply');
    expect(a).toMatchObject({ ok: false, to: crashing, rolled_back: true, database_restored: true });
    expect(a.error).toMatch(/previous version was put back/);
    expect(state('check')).toMatchObject({ ok: false, failed_commit: crashing });
    const health = await (await fetch(`http://127.0.0.1:${env.MPCRM_PORT}/healthz`)).json();
    expect(health.commit).toBe(before);
    expect(fs.readFileSync(path.join(data, 'crm.txt'), 'utf8')).toBe('data before the update');
  }, 30_000);

  it('apply with nothing staged is a no-op (the 3 AM timer)', () => {
    const before = current();
    expect(run('apply').status).toBe(0);
    expect(current()).toBe(before);
  });
});
