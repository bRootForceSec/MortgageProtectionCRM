import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDirs, loadOrCreateToken } from './config.js';
import { openDatabase } from './db/connection.js';
import { buildApp } from './http/app.js';
import { rebuildLeadState } from './domain/leadState.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  ensureDirs(config);
  const db = openDatabase(config.dbFile);
  // lead_state is derived; refreshing it on start keeps time-based statuses current.
  rebuildLeadState(db);
  const token = loadOrCreateToken(config);
  const webDir = [path.resolve(here, '../web'), path.resolve(here, '../../dist/web')].find((d) => fs.existsSync(path.join(d, 'index.html'))) ?? null;
  const app = await buildApp({ db, config, token, webDir, logger: true });

  const pidFile = path.join(config.dataDir, 'server.pid');
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const shutdown = async () => {
    await app.close();
    db.close();
    fs.rmSync(pidFile, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: config.host, port: config.port });
  const url = `http://127.0.0.1:${config.port}/?t=${token}`;
  // Printed to the terminal only (not to the log stream), so the token is not written to log files.
  process.stdout.write(`\nMortgage Protection CRM is running.\nOpen: ${url}\nData: ${config.dataDir}\n\n`);
  if (!webDir) process.stdout.write('Note: the UI is not built yet. Run "npm run build" first.\n');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
