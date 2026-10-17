#!/usr/bin/env node
// Self-updater for an installed copy of the CRM (see scripts/install.sh).
//
//   mpcrm-update.mjs bootstrap   build the latest version and make it current (used by install.sh)
//   mpcrm-update.mjs check       fetch; if there is a newer version, build it next to the running one ("staged")
//   mpcrm-update.mjs apply       back up, switch to the staged version, restart, roll back if it does not come up
//
// Layout under MPCRM_APP_DIR (default ~/.local/share/mpcrm-app):
//   repo/              git clone used for fetching
//   releases/<sha>/    one built copy per version
//   current, previous  symlinks into releases/
//   state/*.json       what the app shows: staged.json, check.json, apply.json
//
// Your data (database, backups, imports) lives in MPCRM_DATA_DIR and is never touched here,
// except that a failed update restores the backup it took a moment earlier.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const env = process.env;
const APP = path.resolve(env.MPCRM_APP_DIR || path.join(os.homedir(), '.local', 'share', 'mpcrm-app'));
const BRANCH = env.MPCRM_UPDATE_BRANCH || 'main';
const PORT = Number(env.MPCRM_PORT || 5170);
const SERVICE = env.MPCRM_SERVICE || 'mpcrm.service';
const HEALTH_TIMEOUT_MS = Number(env.MPCRM_HEALTH_TIMEOUT_MS || 60_000);
const KEEP_RELEASES = 3;
// Tests replace the build with a fast fake. The real build also runs the unit tests, so a broken
// version is never offered, then drops dev-only packages to save disk.
const BUILD_CMD = env.MPCRM_UPDATE_BUILD_CMD || 'npm ci --no-audit --no-fund && npm run build && npm test && npm prune --omit=dev --no-audit --no-fund';

const p = {
  repo: path.join(APP, 'repo'),
  releases: path.join(APP, 'releases'),
  current: path.join(APP, 'current'),
  previous: path.join(APP, 'previous'),
  state: path.join(APP, 'state'),
  lock: path.join(APP, 'state', 'update.lock'),
};
const stateFile = (n) => path.join(p.state, `${n}.json`);

function log(msg) {
  process.stdout.write(`[mpcrm-update] ${msg}\n`);
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(name, data) {
  fs.mkdirSync(p.state, { recursive: true, mode: 0o700 });
  const f = stateFile(name);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}

function git(...args) {
  return execFileSync('git', ['-C', p.repo, ...args], {
    encoding: 'utf8',
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function releaseOf(link) {
  try {
    return path.basename(fs.readlinkSync(link));
  } catch {
    return null;
  }
}

function pointLink(link, sha) {
  const tmp = `${link}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.join('releases', sha), tmp);
  fs.renameSync(tmp, link); // atomic replace
}

function withLock(fn) {
  if (!lockNow()) return 0;
  try {
    return fn();
  } finally {
    fs.rmSync(p.lock, { force: true });
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fetchLatest() {
  git('fetch', '--quiet', 'origin', BRANCH);
  return git('rev-parse', 'FETCH_HEAD');
}

/** Builds <sha> into releases/<sha>. Returns null on success, or an error message. */
function build(sha) {
  const dir = path.join(p.releases, sha);
  if (fs.existsSync(path.join(dir, '.ready'))) return null;
  const tmp = `${dir}.building`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const archive = spawnSync('sh', ['-c', `git -C "${p.repo}" archive "${sha}" | tar -x -C "${tmp}"`], { encoding: 'utf8' });
  if (archive.status !== 0) return `could not unpack version ${sha.slice(0, 7)}: ${archive.stderr.trim()}`;
  const logFile = path.join(p.state, 'build.log');
  const out = fs.openSync(logFile, 'w');
  log(`building ${sha.slice(0, 7)} (log: ${logFile})`);
  const r = spawnSync('sh', ['-c', BUILD_CMD], { cwd: tmp, stdio: ['ignore', out, out], env: { ...env, MPCRM_COMMIT: sha } });
  fs.closeSync(out);
  if (r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return `the build or its tests failed for version ${sha.slice(0, 7)}; details in ${logFile}`;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  fs.writeFileSync(path.join(dir, '.ready'), new Date().toISOString());
  return null;
}

function changesBetween(from, to) {
  if (!from) return [];
  try {
    const out = git('log', '--no-merges', '--format=%s', `${from}..${to}`);
    return out ? out.split('\n').slice(0, 30) : [];
  } catch {
    return [];
  }
}

function prune() {
  const keep = new Set([releaseOf(p.current), releaseOf(p.previous), readJson(stateFile('staged'))?.commit].filter(Boolean));
  const all = fs
    .readdirSync(p.releases)
    .map((name) => ({ name, mtime: fs.statSync(path.join(p.releases, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  let kept = 0;
  for (const r of all) {
    if (keep.has(r.name) || (kept < KEEP_RELEASES && !r.name.endsWith('.building'))) {
      kept++;
      continue;
    }
    fs.rmSync(path.join(p.releases, r.name), { recursive: true, force: true });
  }
}

// ---------- commands ----------

function bootstrap() {
  return withLock(() => {
    fs.mkdirSync(p.releases, { recursive: true });
    const sha = fetchLatest();
    const err = build(sha);
    if (err) {
      log(err);
      return 1;
    }
    pointLink(p.current, sha);
    writeState('check', { ok: true, latest: sha });
    log(`installed version ${sha.slice(0, 7)}`);
    return 0;
  });
}

function check() {
  return withLock(() => {
    let sha;
    try {
      sha = fetchLatest();
    } catch (e) {
      writeState('check', { ok: false, error: `could not reach GitHub: ${String(e.stderr || e.message).trim().split('\n')[0]}` });
      return 1;
    }
    const cur = releaseOf(p.current);
    if (sha === cur) {
      fs.rmSync(stateFile('staged'), { force: true });
      writeState('check', { ok: true, latest: sha });
      log('already up to date');
      return 0;
    }
    const failed = readJson(stateFile('check'));
    if (failed && !failed.ok && failed.failed_commit === sha) {
      log(`version ${sha.slice(0, 7)} failed to build before; waiting for a newer one`);
      return 0;
    }
    const err = build(sha);
    if (err) {
      writeState('check', { ok: false, error: err, failed_commit: sha });
      return 1;
    }
    writeState('staged', { commit: sha, from: cur, changes: changesBetween(cur, sha) });
    writeState('check', { ok: true, latest: sha });
    prune();
    log(`version ${sha.slice(0, 7)} is ready to install`);
    return 0;
  });
}

async function apply() {
  const staged = readJson(stateFile('staged'));
  if (!staged || !fs.existsSync(path.join(p.releases, staged.commit, '.ready'))) {
    log('nothing to install');
    return 0;
  }
  if (!lockNow()) return 0;
  try {
    const from = releaseOf(p.current);
    const to = staged.commit;
    // 1. Back up with the running version (safe while it is running).
    const backup = runNode(p.current, ['dist/server/cli.js', 'backup']);
    if (backup.status !== 0) {
      writeState('apply', { ok: false, from, to, error: `backup failed, so the update was not installed: ${tail(backup)}` });
      return 1;
    }
    const backupFile = /Backup written: (.+?) \(/.exec(backup.stdout)?.[1] ?? null;

    // 2. Switch and restart.
    if (from) pointLink(p.previous, from);
    pointLink(p.current, to);
    systemctl('restart', SERVICE);
    if (await healthy(to)) {
      fs.rmSync(stateFile('staged'), { force: true });
      writeState('apply', { ok: true, from, to, changes: staged.changes ?? [], backup: backupFile });
      installSelf(to);
      prune();
      log(`now running version ${to.slice(0, 7)}`);
      return 0;
    }

    // 3. It did not come up: go back to the old version and the database as it was before the update.
    log(`version ${to.slice(0, 7)} did not start; rolling back`);
    systemctl('stop', SERVICE);
    let restored = false;
    if (backupFile && from) {
      const r = runNode(p.previous, ['dist/server/cli.js', 'restore', backupFile]);
      restored = r.status === 0;
      if (!restored) log(`restore failed: ${tail(r)}`);
    }
    if (from) pointLink(p.current, from);
    systemctl('start', SERVICE);
    const back = from ? await healthy(from) : false;
    fs.rmSync(stateFile('staged'), { force: true });
    writeState('check', { ok: false, error: `version ${to.slice(0, 7)} did not start`, failed_commit: to });
    writeState('apply', {
      ok: false,
      from,
      to,
      rolled_back: back,
      database_restored: restored,
      backup: backupFile,
      error: back
        ? `The new version did not start, so the previous version was put back${restored ? ' with your data as it was just before the update' : ''}.`
        : `The new version did not start and the previous version did not come back either. Your backup is ${backupFile}.`,
    });
    return 1;
  } finally {
    fs.rmSync(p.lock, { force: true });
  }
}

function lockNow() {
  fs.mkdirSync(p.state, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(p.lock, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    const pid = Number(fs.readFileSync(p.lock, 'utf8'));
    if (pid && alive(pid)) {
      log(`another update step is running (pid ${pid}); skipping`);
      return false;
    }
    fs.writeFileSync(p.lock, String(process.pid));
    return true;
  }
}

function runNode(releaseLink, args) {
  return spawnSync(process.execPath, args, { cwd: fs.realpathSync(releaseLink), encoding: 'utf8', env });
}

function tail(r) {
  return `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-3).join(' ');
}

function systemctl(...args) {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  if (r.status !== 0) log(`systemctl ${args.join(' ')} failed: ${tail(r)}`);
  return r.status === 0;
}

async function healthy(sha) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok && (await res.json()).commit === sha) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** After a successful update, refresh the updater itself and the service files from the new version. */
function installSelf(sha) {
  const rel = path.join(p.releases, sha);
  const src = path.join(rel, 'scripts', 'install.sh');
  if (!fs.existsSync(src)) return;
  const r = spawnSync('bash', [src, '--refresh'], { encoding: 'utf8', env: { ...env, MPCRM_APP_DIR: APP } });
  if (r.status !== 0) log(`refreshing service files failed: ${tail(r)}`);
}

const cmd = process.argv[2];
const commands = { bootstrap, check, apply };
if (!commands[cmd]) {
  process.stderr.write('usage: mpcrm-update.mjs bootstrap|check|apply\n');
  process.exit(2);
}
process.exitCode = await commands[cmd]();
