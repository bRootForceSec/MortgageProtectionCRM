import { startServer } from './server.js';

// `npm start` and the Linux background service: run the CRM and print the private link.

async function main() {
  const s = await startServer();
  const shutdown = async () => {
    await s.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Printed to the terminal only (not to the log stream), so the token is not written to log files.
  process.stdout.write(`\nMortgage Protection CRM is running.\nOpen: ${s.url}\nData: ${s.config.dataDir}\n\n`);
  if (!s.webBuilt) process.stdout.write('Note: the UI is not built yet. Run "npm run build" first.\n');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
