import { app, net } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronUpdater from 'electron-updater';
import type { UpdateProvider, UpdateStatus } from '../server/updates.js';
import { REPO, RELEASES_PAGE, compareVersions, notesToChanges, parseMacFeed, sha512Base64, macSwapScript } from './updateLogic.js';

// Updates the desktop app from the repository's GitHub Releases page.
// Windows and Linux (AppImage) use electron-updater. Apple's updater only works for signed apps, so on a Mac
// the app downloads the new zip itself, checks it, and swaps itself on restart.

type Status = Pick<UpdateStatus, 'staged' | 'last_check' | 'last_apply'>;

export interface DesktopUpdaterOptions {
  currentVersion: string;
  lastApply: UpdateStatus['last_apply'];
  /** Takes a verified backup and returns its file. Throws if it can't, which stops the update. */
  backup(): Promise<string>;
  /** Remembers what is being installed, so the next start can tell whether it worked. */
  rememberPending(p: { from: string; to: string; backup: string; changes: string[] }): void;
  /** Stops the server cleanly and lets the app quit. */
  beforeInstall(): Promise<void>;
  log(msg: string): void;
}

export interface DesktopUpdater extends UpdateProvider {
  start(): void;
  /** Installs a downloaded update if it's 3 AM and the computer has been idle (left alone overnight). */
  maybeInstallOvernight(idleSeconds: number, now?: Date): void;
}

const now = () => new Date().toISOString();

// Tests point the updater at a local folder of release files instead of GitHub.
const FEED = process.env.MPCRM_UPDATE_FEED?.replace(/\/+$/, '') || null;

export function createDesktopUpdater(o: DesktopUpdaterOptions): DesktopUpdater {
  const s: Status = { staged: null, last_check: null, last_apply: o.lastApply };
  let checking = false;
  let installing = false;

  const fail = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    s.last_check = { ok: false, error: `${msg.split('\n')[0]} (you can download the new version from ${RELEASES_PAGE})`, at: now() };
    o.log(`update check failed: ${msg}`);
  };

  const prepareInstall = async (to: string, changes: string[]) => {
    const backup = await o.backup();
    o.rememberPending({ from: o.currentVersion, to, backup, changes });
    await o.beforeInstall();
  };

  // ---------- Windows and Linux ----------
  const { autoUpdater } = electronUpdater;
  const canUseElectronUpdater = app.isPackaged && (process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE));

  if (canUseElectronUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = { info: (m: unknown) => o.log(String(m)), warn: (m: unknown) => o.log(String(m)), error: (m: unknown) => o.log(String(m)), debug: () => {} } as any;
    autoUpdater.on('update-not-available', () => (s.last_check = { ok: true, latest: o.currentVersion, at: now() }));
    autoUpdater.on('update-downloaded', (info) => {
      s.staged = { commit: info.version, from: o.currentVersion, changes: notesToChanges(info.releaseNotes), at: now() };
      s.last_check = { ok: true, latest: info.version, at: now() };
    });
    autoUpdater.on('error', fail);
    if (FEED) autoUpdater.setFeedURL({ provider: 'generic', url: FEED });
  }

  // ---------- Mac ----------
  let macStagedApp: string | null = null;

  async function macCheck() {
    const base = FEED ?? `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest/download`;
    const ymlRes = await net.fetch(`${base}/latest-mac.yml`, { cache: 'no-store' });
    if (!ymlRes.ok) throw new Error(`GitHub answered ${ymlRes.status}`);
    const feed = parseMacFeed(await ymlRes.text(), process.arch);
    if (compareVersions(feed.version, o.currentVersion) <= 0) {
      s.last_check = { ok: true, latest: feed.version, at: now() };
      return;
    }
    if (s.staged?.commit === feed.version && macStagedApp && fs.existsSync(macStagedApp)) return;

    let changes: string[] = [];
    if (!FEED) try {
      const rel = await net.fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
      if (rel.ok) changes = notesToChanges(((await rel.json()) as { body?: string }).body);
    } catch {
      // the list of changes is optional
    }

    const zipRes = await net.fetch(`${base}/${encodeURIComponent(feed.zip.url)}`);
    if (!zipRes.ok) throw new Error(`downloading the update failed (GitHub answered ${zipRes.status})`);
    const zip = Buffer.from(await zipRes.arrayBuffer());
    if (sha512Base64(zip) !== feed.zip.sha512) throw new Error('the downloaded update was damaged (checksum mismatch)');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-update-'));
    fs.writeFileSync(path.join(dir, 'update.zip'), zip);
    execFileSync('ditto', ['-x', '-k', path.join(dir, 'update.zip'), path.join(dir, 'app')]);
    const bundle = fs.readdirSync(path.join(dir, 'app')).find((f) => f.endsWith('.app'));
    if (!bundle) throw new Error('the update has no app in it');
    macStagedApp = path.join(dir, 'app', bundle);
    s.staged = { commit: feed.version, from: o.currentVersion, changes, at: now() };
    s.last_check = { ok: true, latest: feed.version, at: now() };
  }

  function currentMacBundle() {
    // .../Mortgage Protection CRM.app/Contents/MacOS/Mortgage Protection CRM
    return path.resolve(process.execPath, '..', '..', '..');
  }

  async function macApply() {
    if (!macStagedApp || !s.staged) throw new Error('there is no update ready to install');
    const target = currentMacBundle();
    try {
      fs.accessSync(path.dirname(target), fs.constants.W_OK);
    } catch {
      throw new Error(`can't replace the app in ${path.dirname(target)}. Download the new version from ${RELEASES_PAGE} instead`);
    }
    await prepareInstall(s.staged.commit, s.staged.changes);
    const child = spawn('/bin/sh', ['-c', macSwapScript(process.pid, target, macStagedApp)], { detached: true, stdio: 'ignore' });
    child.unref();
    app.exit(0);
  }

  // ---------- shared ----------
  const provider: DesktopUpdater = {
    status: () => s,
    async check() {
      if (checking) return;
      checking = true;
      try {
        if (process.platform === 'darwin' && app.isPackaged) await macCheck();
        else if (canUseElectronUpdater) await autoUpdater.checkForUpdates();
        else s.last_check = { ok: false, error: `this copy can't update itself; download new versions from ${RELEASES_PAGE}`, at: now() };
      } catch (e) {
        fail(e);
      } finally {
        checking = false;
      }
    },
    async apply() {
      if (!s.staged || installing) return;
      installing = true;
      try {
        if (process.platform === 'darwin') return await macApply();
        await prepareInstall(s.staged.commit, s.staged.changes);
        // Silent install, then start the new version.
        autoUpdater.quitAndInstall(true, true);
      } catch (e) {
        installing = false;
        throw e;
      }
    },
    start() {
      const run = () => void provider.check();
      setTimeout(run, 30_000).unref?.();
      setInterval(run, 3600_000).unref?.();
    },
    maybeInstallOvernight(idleSeconds, at = new Date()) {
      if (s.staged && !installing && at.getHours() === 3 && idleSeconds > 15 * 60) {
        o.log(`installing update ${s.staged.commit} overnight`);
        provider.apply().catch((e) => o.log(`overnight update failed: ${e.message}`));
      }
    },
  };
  return provider;
}
