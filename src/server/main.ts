import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDirs, loadOrCreateToken } from './config.js';
import { openDatabase } from './db/connection.js';
import { buildApp } from './http/app.js';
import { rebuildLeadState } from './domain/leadState.js';
import { Updates, readBuildInfo } from './updates.js';
import { DraftWorker } from './domain/drafts.js';
import { Secrets } from './ai/settings.js';
import { runBackupCheckIfDue } from './http/reportRoutes.js';
import { GoogleCalendar } from './calendar/google.js';
import { CalendarWorker } from './calendar/sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  ensureDirs(config);
  const db = openDatabase(config.dbFile);
  // lead_state is derived; refreshing it on start keeps time-based statuses current.
  rebuildLeadState(db);
  const token = loadOrCreateToken(config);
  const webDir = [path.resolve(here, '../web'), path.resolve(here, '../../dist/web')].find((d) => fs.existsSync(path.join(d, 'index.html'))) ?? null;
  const build = readBuildInfo(path.resolve(here, '../build-info.json'));
  const updates = new Updates(process.env.MPCRM_APP_DIR ? path.resolve(process.env.MPCRM_APP_DIR) : null, build);
  const secrets = Secrets.inDataDir(config.dataDir);
  const drafts = new DraftWorker(db, secrets);
  const google = new GoogleCalendar(db, secrets);
  let app: Awaited<ReturnType<typeof buildApp>>;
  const calendar = new CalendarWorker(db, google, { log: (msg, extra) => app?.log.warn(extra as object, msg) });
  app = await buildApp({ db, config, token, webDir, logger: true, updates, drafts, secrets, google, calendar });

  const pidFile = path.join(config.dataDir, 'server.pid');
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const shutdown = async () => {
    calendar.stop();
    await app.close();
    db.close();
    fs.rmSync(pidFile, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: config.host, port: config.port });
  // Carry on reading any PDF import that was in progress when the app stopped.
  drafts.resumeAll();
  // Keep appointments on Google Calendar and put your notes on Unitrust's events (checks once a minute).
  calendar.start();
  // Once a week, check that the newest backup restores cleanly into a scratch copy.
  const checkBackups = () => {
    try {
      runBackupCheckIfDue(db, config);
    } catch (e: any) {
      app.log.error({ err: e.message }, 'backup restore check failed to run');
    }
  };
  setTimeout(checkBackups, 60_000).unref();
  setInterval(checkBackups, 6 * 3600_000).unref();
  const url = `http://127.0.0.1:${config.port}/?t=${token}`;
  // Printed to the terminal only (not to the log stream), so the token is not written to log files.
  process.stdout.write(`\nMortgage Protection CRM is running.\nOpen: ${url}\nData: ${config.dataDir}\n\n`);
  if (!webDir) process.stdout.write('Note: the UI is not built yet. Run "npm run build" first.\n');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
