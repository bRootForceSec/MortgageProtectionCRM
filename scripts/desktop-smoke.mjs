// Starts the packaged desktop app (from `electron-builder`) with a throwaway data folder and checks that
// the CRM opens in its window and shuts down cleanly. Used by CI on Windows, Mac and Linux.
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const name = 'Mortgage Protection CRM';
const candidates = {
  linux: ['release/linux-unpacked/mortgage-protection-crm'],
  win32: [`release/win-unpacked/${name}.exe`],
  darwin: [`release/mac-${process.arch}/${name}.app/Contents/MacOS/${name}`, `release/mac/${name}.app/Contents/MacOS/${name}`],
}[process.platform];
const exe = candidates.map((p) => path.resolve(p)).find((p) => fs.existsSync(p));
if (!exe) throw new Error(`packaged app not found; looked for ${candidates.join(', ')}`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-desktop-'));
const app = await electron.launch({
  executablePath: exe,
  // GitHub's Linux runners block Chromium's sandbox; real installs keep it.
  args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  env: { ...process.env, MPCRM_DATA_DIR: dataDir, MPCRM_PORT: '5198' },
  timeout: 60_000,
});
try {
  const win = await app.firstWindow();
  await win.getByText('Your call list is empty').waitFor({ timeout: 30_000 });
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(win.url())) throw new Error(`unexpected window address ${win.url()}`);
  await win.screenshot({ path: path.resolve('release', `smoke-${process.platform}.png`) });
  console.log(`OK: the app opened its window from ${exe}`);
} finally {
  await app.close();
}
for (const f of ['crm.sqlite', 'access-token', path.join('logs', 'app.log')]) {
  if (!fs.existsSync(path.join(dataDir, f))) throw new Error(`expected ${f} in the data folder`);
}
if (fs.existsSync(path.join(dataDir, 'server.pid'))) throw new Error('the app did not shut its server down cleanly');
console.log('OK: data folder created and server stopped cleanly');
