import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5199;
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

test.afterAll(() => {
  server?.kill('SIGTERM');
});

test('import a sheet, log calls by keyboard, and move a lead to the dead pile', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  await expect(page).toHaveURL(`http://127.0.0.1:${PORT}/`);

  // Add the caller ID number used on Sideline.
  await page.getByRole('button', { name: 'Numbers' }).click();
  await page.getByPlaceholder('(614) 555-0199').fill('614-555-0199');
  await page.getByPlaceholder('e.g. Sideline').fill('Sideline');
  await page.getByRole('button', { name: 'Add number' }).click();
  await expect(page.getByRole('cell', { name: '(614) 555-0199' })).toBeVisible();

  // Import.
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const file = path.join(dataDir, 'October leads.csv');
  fs.copyFileSync('test/fixtures/sample-leads.csv', file);
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.getByText('Match the columns')).toBeVisible();
  await expect(page.getByLabel('Column for Phone')).toHaveValue('Phone');
  await page.getByRole('button', { name: 'Continue' }).click();
  // The rows with no usable phone open in the review window; discard both.
  await expect(page.getByText('2 leads need a look')).toBeVisible();
  await page.screenshot({ path: 'test-results/import-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Check them now' }).click();
  await expect(page.getByRole('dialog', { name: 'Check this lead' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('no phone number')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('dialog', { name: 'Check this lead' })).toContainText('row 6');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Import 4 leads' }).click();
  await expect(page.getByText('Import finished')).toBeVisible();
  await page.getByRole('button', { name: 'Start calling' }).click();

  // Calling screen: first lead is selected and shows the phone.
  await expect(page.locator('.phone-big')).toBeVisible();
  const first = await page.locator('.lead-name').innerText();
  await expect(page.getByLabel('Queue').locator('li')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/calling.png', fullPage: true });

  // Voicemail left: press 2 then Enter.
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/^Saved: Voicemail, message left/).first()).toBeVisible();
  await expect(page.getByLabel('History').getByText('Voicemail, message left')).toBeVisible();
  await expect(page.getByLabel('History').getByText('from Sideline')).toBeVisible();
  await expect(page.locator('.topbar .stats')).toContainText('Calls 1');

  // Next lead.
  await page.keyboard.press('n');
  await expect(page.locator('.lead-name')).not.toHaveText(first);
  const second = await page.locator('.lead-name').innerText();

  // Do-not-call request → dead pile (confirm dialog auto-accepted).
  await page.keyboard.press('d');
  await expect(page.getByRole('button', { name: /Do-not-call request/ })).toHaveClass(/active/);
  await page.keyboard.press('Enter');
  await expect(page.getByText('This lead is in the dead pile.')).toBeVisible();
  // Jane waits 4 hours for a retry and Robert is dead, so two leads remain.
  await expect(page.getByLabel('Queue').locator('li')).toHaveCount(2);

  // The dead pile lists it.
  await page.getByRole('button', { name: 'Leads' }).click();
  await page.getByRole('button', { name: 'Dead pile' }).click();
  await expect(page.locator('table.grid tbody tr')).toHaveCount(1);
  await expect(page.locator('table.grid tbody tr')).toContainText(second);

  // Refresh keeps the selected lead.
  await page.getByRole('button', { name: 'Calling' }).click();
  await page.reload();
  await expect(page.locator('.lead-name')).toHaveText(second);
});

test('API refuses requests without the access cookie', async ({ request }) => {
  const r = await request.get(`http://127.0.0.1:${PORT}/api/meta`);
  expect(r.status()).toBe(401);
});
