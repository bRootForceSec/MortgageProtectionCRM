import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5197;
let server: ChildProcess;
let launchUrl = '';
let dataDir = '';

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-e2e-'));
  server = spawn('node', ['dist/server/main.js'], { env: { ...process.env, MPCRM_DATA_DIR: dataDir, MPCRM_PORT: String(PORT) } });
  launchUrl = await new Promise<string>((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (d) => {
      out += d;
      const m = out.match(/Open: (http\S+)/);
      if (m) resolve(m[1]!);
    });
    server.on('exit', (c) => reject(new Error(`server exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15_000);
  });
});

test.afterAll(async () => {
  // Once the server has stopped, its data folder goes, so runs don't fill the disk.
  if (server && server.exitCode === null) {
    await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); setTimeout(r, 5000); });
  }
  // Best-effort: Windows won't delete a file a server that didn't stop in time still has open.
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

test('T then a number shows a text as a QR code, Enter notes it on the lead; V ticks Left voicemail', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  await page.locator('.topbar nav').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Your name, for [[my_name]]').fill('Alistair');
  await page.getByLabel('Your name, for [[my_name]]').blur();
  await expect(page.getByLabel('First touch text')).toBeVisible();
  await page.screenshot({ path: 'test-results/texts-settings.png', fullPage: true });

  await page.locator('.topbar nav').getByRole('button', { name: 'Import', exact: true }).click();
  const file = path.join(dataDir, 'October leads.csv');
  fs.copyFileSync('test/fixtures/sample-leads.csv', file);
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(file);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Check them now' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: /Import \d+ leads/ }).click();
  await page.getByRole('button', { name: 'Start calling' }).click();
  await expect(page.locator('.phone-big')).toBeVisible();
  const first = (await page.locator('.lead-name').innerText()).trim().split(/\s+/)[0]!;

  await page.keyboard.press('v');
  await expect(page.getByLabel('Left voicemail')).toBeChecked();
  await page.keyboard.press('t');
  const picker = page.getByRole('dialog', { name: /^Text / });
  await expect(picker.getByRole('list', { name: 'Your texts' })).toBeVisible();
  await page.screenshot({ path: 'test-results/texts-picker.png' });
  await page.keyboard.press('2');
  await expect(picker.locator('canvas')).toBeVisible();
  await expect(picker.locator('.text-preview')).toContainText(`Hi ${first.charAt(0)}${first.slice(1).toLowerCase()}`);
  await expect(picker.locator('.text-preview')).toContainText('Alistair');
  await page.screenshot({ path: 'test-results/texts-qr.png' });
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(page.getByText(/Noted: texted .* "Missed you"/)).toBeVisible();
  // Still ticked after texting, so the call saves with it.
  await expect(page.getByLabel('Left voicemail')).toBeChecked();
});
