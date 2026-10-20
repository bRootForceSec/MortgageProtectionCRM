import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { loadConfig, ensureDirs, loadOrCreateToken, type Config } from './config.js';
import { openDatabase, type DB } from './db/connection.js';
import { buildApp } from './http/app.js';
import { rebuildLeadState } from './domain/leadState.js';
import { Updates, readBuildInfo, type Runtime, type UpdateProvider } from './updates.js';
import { DraftWorker } from './domain/drafts.js';
import { Secrets } from './ai/settings.js';
import { runBackupCheckIfDue } from './http/reportRoutes.js';

// Starts the CRM: database, HTTP server, background jobs. Used by `npm start` (main.ts) and the desktop app.

const here = path.dirname(fileURLToPath(import.meta.url));

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  runtime?: Runtime;
  /** Use another free port when the configured one is taken (the desktop app does; a service should fail loudly). */
  portFallback?: boolean;
  logStream?: NodeJS.WritableStream;
  /** The desktop app's updater. */
  updater?: UpdateProvider;
}

export interface RunningServer {
  app: FastifyInstance;
  db: DB;
  config: Config;
  token: string;
  url: string;
  webBuilt: boolean;
  stop(): Promise<void>;
}

export class AlreadyRunningError extends Error {
  constructor(readonly pid: number, readonly dataDir: string) {
    super(`The CRM is already running from this data folder (process ${pid}).`);
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means it exists but belongs to someone else.
    return e?.code === 'EPERM';
  }
}

/** The pid of another copy of the CRM using this data folder, if one is running. */
export function otherRunningCopy(dataDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir, 'server.pid'), 'utf8'));
    return pid && pid !== process.pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function portIsFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

function anyFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, host, () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const config = loadConfig(opts.env ?? process.env);
  ensureDirs(config);
  const other = otherRunningCopy(config.dataDir);
  if (other) throw new AlreadyRunningError(other, config.dataDir);
  if (opts.portFallback && !(await portIsFree(config.port, config.host))) config.port = await anyFreePort(config.host);

  const db = openDatabase(config.dbFile);
  // lead_state is derived; refreshing it on start keeps time-based statuses current.
  rebuildLeadState(db);
  const token = loadOrCreateToken(config);
  const webDir = [path.resolve(here, '../web'), path.resolve(here, '../../dist/web')].find((d) => fs.existsSync(path.join(d, 'index.html'))) ?? null;
  const build = readBuildInfo(path.resolve(here, '../build-info.json'));
  const env = opts.env ?? process.env;
  const updates = new Updates(env.MPCRM_APP_DIR ? path.resolve(env.MPCRM_APP_DIR) : null, build, undefined, opts.runtime, opts.updater);
  const secrets = Secrets.inDataDir(config.dataDir);
  const drafts = new DraftWorker(db, secrets);
  const app = await buildApp({ db, config, token, webDir, logger: true, logStream: opts.logStream, updates, drafts, secrets });

  const pidFile = path.join(config.dataDir, 'server.pid');
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });

  await app.listen({ host: config.host, port: config.port });
  // Carry on reading any PDF import that was in progress when the app stopped.
  drafts.resumeAll();
  // Once a week, check that the newest backup restores cleanly into a scratch copy.
  const checkBackups = () => {
    try {
      runBackupCheckIfDue(db, config);
    } catch (e: any) {
      app.log.error({ err: e.message }, 'backup restore check failed to run');
    }
  };
  const t1 = setTimeout(checkBackups, 60_000);
  const t2 = setInterval(checkBackups, 6 * 3600_000);
  t1.unref();
  t2.unref();

  let stopped = false;
  return {
    app,
    db,
    config,
    token,
    url: `http://127.0.0.1:${config.port}/?t=${token}`,
    webBuilt: !!webDir,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(t1);
      clearInterval(t2);
      await app.close();
      db.close();
      fs.rmSync(pidFile, { force: true });
    },
  };
}
