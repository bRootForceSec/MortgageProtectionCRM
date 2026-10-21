import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, powerMonitor, session, shell, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AlreadyRunningError, type RunningServer } from '../server/server.js';
import { loadConfig } from '../server/config.js';
import { createBackup, restoreBackup } from '../server/backup.js';
import { scheduleBackups, type BackupScheduler } from '../server/backupSchedule.js';
import { linuxLaunchCommand, linuxLoginItem, type LoginItem } from './autostart.js';
import { createDesktopUpdater, type DesktopUpdater } from './updater.js';
import { RELEASES_PAGE } from './updateLogic.js';
import type { UpdateStatus } from '../server/updates.js';

interface Pending {
  from: string;
  to: string;
  backup: string;
  changes: string[];
}

// The desktop app: runs the CRM server inside the app and shows it in its own window.
// Closing the window keeps it running in the tray (so callback alerts still fire); Quit is in the tray menu.

const assets = path.join(app.getAppPath(), 'assets');
const startHidden = process.argv.includes('--hidden');

let server: RunningServer | null = null;
let backups: BackupScheduler | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let updater: DesktopUpdater | null = null;

app.setName('Mortgage Protection CRM');
if (process.platform === 'win32') app.setAppUserModelId('com.brootforcesec.mortgagecrm');

if (!app.requestSingleInstanceLock()) {
  // Another copy is open: it gets a 'second-instance' event and shows its window.
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start).catch(fatal);
}

function loginItem(): LoginItem {
  if (process.platform === 'linux') {
    return linuxLoginItem(linuxLaunchCommand(process.env, process.execPath, app.isPackaged ? null : app.getAppPath()));
  }
  return {
    get: () => app.getLoginItemSettings().openAtLogin,
    set: (on) => app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }),
  };
}

/** Small per-install state kept in the data folder. */
function desktopState(dataDir: string) {
  const file = path.join(dataDir, 'desktop.json');
  const read = (): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    read,
    write(patch: Record<string, unknown>) {
      // Write a temp file, then rename it over the old one, so a crash mid-write can't leave a half-written file.
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...read(), ...patch }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

function openLog(dataDir: string) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'app.log');
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
  return fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
}

async function start() {
  const config = loadConfig();
  const log = openLog(config.dataDir);
  const note = (msg: string) => log.write(`${JSON.stringify({ time: Date.now(), msg })}\n`);
  const state = desktopState(config.dataDir);
  const current = app.getVersion();
  const saved = state.read();
  const pending = (saved.pending as Pending | undefined) ?? null;

  // Did an update just happen? Then show it as the last update.
  let lastApply = (saved.last_apply as UpdateStatus['last_apply']) ?? null;
  if (typeof saved.last_version === 'string' && saved.last_version !== current) {
    lastApply = { ok: true, from: saved.last_version, to: current, changes: pending?.changes ?? [], at: new Date().toISOString() };
  }

  updater = createDesktopUpdater({
    currentVersion: current,
    lastApply,
    backup: async () => {
      if (!server) throw new Error('the app is not running');
      return (await createBackup(server.db, server.config)).file;
    },
    rememberPending: (p) => state.write({ pending: p }),
    beforeInstall: async () => {
      quitting = true;
      backups?.stop();
      const s = server;
      server = null;
      await s?.stop();
    },
    log: note,
  });

  try {
    server = await startServer({ runtime: 'desktop', portFallback: true, logStream: log, updater });
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      await dialog.showMessageBox({
        type: 'info',
        message: 'The CRM is already running',
        detail:
          `Another copy is already using your data folder (${e.dataDir}), for example the background service from the Linux install. ` +
          'Only one copy can use it at a time. Close that one first, or open it from your app menu.',
      });
      app.exit(0);
      return;
    }
    if (pending && pending.to === current && fs.existsSync(pending.backup)) {
      await undoFailedUpdate(config, pending, e, state, note);
      app.exit(1);
      return;
    }
    throw e;
  }
  note(`started version ${current} on port ${server.config.port}`);
  state.write({ last_version: current, pending: null, last_apply: lastApply });
  backups = scheduleBackups(server.db, server.config, note);
  updater.start();
  setInterval(() => updater?.maybeInstallOvernight(powerMonitor.getSystemIdleTime()), 10 * 60_000).unref();

  if (!saved.first_run_done) {
    // Start at login by default, like the Linux service did.
    try {
      loginItem().set(true);
    } catch (e: any) {
      note(`could not set start at login: ${e.message}`);
    }
    state.write({ first_run_done: true });
  }

  lockDownSession(server.config.port);
  createTray();
  if (!startHidden) showWindow();
  if (process.platform === 'darwin') app.on('activate', () => showWindow());
}

/**
 * The new version couldn't start (for example a database change failed). Put the data back exactly as it was
 * just before the update, and point to the previous version's download.
 */
async function undoFailedUpdate(config: ReturnType<typeof loadConfig>, p: Pending, err: unknown, state: ReturnType<typeof desktopState>, note: (m: string) => void) {
  const why = err instanceof Error ? err.message : String(err);
  note(`version ${p.to} failed to start: ${why}`);
  let restored = false;
  try {
    fs.rmSync(path.join(config.dataDir, 'server.pid'), { force: true });
    restoreBackup(config, p.backup);
    restored = true;
  } catch (e: any) {
    note(`restoring the pre-update backup failed: ${e.message}`);
  }
  const error = restored
    ? `Version ${p.to} could not open your data, so your data was put back exactly as it was before the update. Install version ${p.from} again from the downloads page.`
    : `Version ${p.to} could not open your data, and putting the backup back also failed. Your backup is ${p.backup}.`;
  state.write({ pending: null, last_version: p.from, last_apply: { ok: false, from: p.from, to: p.to, error, at: new Date().toISOString() } });
  const r = await dialog.showMessageBox({
    type: 'error',
    message: "The update didn't work",
    detail: `${error}\n\nWhat went wrong: ${why}`,
    buttons: ['Open downloads page', 'Close'],
    defaultId: 0,
  });
  if (r.response === 0) await shell.openExternal(`${RELEASES_PAGE}/tag/v${p.from}`);
}

/** Only our own local server is shown in the window; other links open in the normal browser. */
function lockDownSession(port: number) {
  const ours = (url: string) => {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) === port;
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(ours(wc.getURL()) && ['notifications', 'media', 'clipboard-sanitized-write'].includes(permission));
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url) && !ours(url)) void shell.openExternal(url);
      else if (ours(url)) return { action: 'allow' };
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (!ours(url)) {
        e.preventDefault();
        if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      }
    });
  });
}

function showWindow() {
  if (!server) return;
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      title: 'Mortgage Protection CRM',
      icon: path.join(assets, 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        win?.hide();
      }
    });
    void win.loadURL(server.url);
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(assets, 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('Mortgage Protection CRM');
  tray.on('click', () => showWindow());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  let atLogin = false;
  try {
    atLogin = loginItem().get();
  } catch {
    // not supported here
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Mortgage Protection CRM', click: () => showWindow() },
      { label: 'Back up now', click: () => void backUpNow() },
      { label: 'Open data folder', click: () => server && void shell.openPath(server.config.dataDir) },
      { label: 'Check for updates', click: () => void updater?.check() },
      { type: 'separator' },
      {
        label: 'Start when I log in',
        type: 'checkbox',
        checked: atLogin,
        click: (item) => {
          try {
            loginItem().set(item.checked);
          } catch (e: any) {
            void dialog.showMessageBox({ type: 'error', message: "Couldn't change start at login", detail: e.message });
          }
          refreshTrayMenu();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

async function backUpNow() {
  if (!server) return;
  try {
    const r = await createBackup(server.db, server.config);
    new Notification({ title: 'Backup done', body: path.basename(r.file) }).show();
  } catch (e: any) {
    void dialog.showMessageBox({ type: 'error', message: 'Backup failed', detail: e.message });
  }
}

app.on('before-quit', (e) => {
  if (quitting || !server) {
    quitting = true;
    return;
  }
  // Close the server and database cleanly before exiting.
  e.preventDefault();
  quitting = true;
  backups?.stop();
  void server.stop().finally(() => app.quit());
});

// Keep running in the tray when the window is closed.
app.on('window-all-closed', () => {});

function fatal(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  dialog.showErrorBox('Mortgage Protection CRM could not start', msg);
  app.exit(1);
}

