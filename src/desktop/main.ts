import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session, shell, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, AlreadyRunningError, type RunningServer } from '../server/server.js';
import { loadConfig } from '../server/config.js';
import { createBackup } from '../server/backup.js';
import { scheduleBackups, type BackupScheduler } from '../server/backupSchedule.js';
import { linuxLaunchCommand, linuxLoginItem, type LoginItem } from './autostart.js';

// The desktop app: runs the CRM server inside the app and shows it in its own window.
// Closing the window keeps it running in the tray (so callback alerts still fire); Quit is in the tray menu.

const assets = path.join(app.getAppPath(), 'assets');
const startHidden = process.argv.includes('--hidden');

let server: RunningServer | null = null;
let backups: BackupScheduler | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

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
      fs.writeFileSync(file, JSON.stringify({ ...read(), ...patch }, null, 2), { mode: 0o600 });
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
  try {
    server = await startServer({ runtime: 'desktop', portFallback: true, logStream: log });
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
    throw e;
  }
  note(`started on port ${server.config.port}`);
  backups = scheduleBackups(server.db, server.config, note);

  const state = desktopState(server.config.dataDir);
  if (!state.read().first_run_done) {
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

