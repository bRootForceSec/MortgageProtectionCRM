import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5198;
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
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('policies from Unitrust: set a new product\'s comp rules; Reports shows no profit for now', async ({ page }) => {
  await page.goto(launchUrl);
  const origin = `http://127.0.0.1:${PORT}`;
  const { key } = await (await page.request.post(`${origin}/api/unitrust/key`, { headers: { origin } })).json();
  // Today where the browser is (playwright.config.ts), not where this test runs: just after midnight UTC they differ.
  const day = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' });
  const sent = await page.request.post(`${origin}/api/unitrust/policies`, {
    headers: { 'x-mpcrm-extension-key': key, origin: 'moz-extension://abc' },
    data: {
      level: 70,
      policies: [
        { app_id: 'Uni-100001', client_name: 'Pat Sample', client_phone: '(312) 555-0144', carrier: 'AMERICO', product: 'Term 100', capped_apv: '$663.48', apv: '$663.48', status: 'Issue-Paid', submitted: day, paid: day },
        { app_id: 'Uni-100002', client_name: 'Chris Example', client_phone: '(312) 555-0145', carrier: 'AMERICAN AMICABLE', product: 'Home Certainty', capped_apv: '$1,036.68', status: 'Issued Not Paid', submitted: day },
      ],
    },
  });
  expect((await sent.json()).needs_rules).toBe(2);

  await page.reload();
  await expect(page.getByText('2 products from Unitrust need comp rules')).toBeVisible();
  await page.getByRole('button', { name: 'Set comp rules' }).click();
  await expect(page.getByRole('heading', { name: 'Products and comp' })).toBeVisible();
  await page.getByLabel('Term 100 type').selectOption('term');
  await page.getByLabel('Term 100 comp hit').fill('10');
  await page.getByLabel('Term 100 advance %').fill('75');
  await expect(page.getByRole('row', { name: /Term 100/ })).toContainText('60% × 75%');
  await page.getByRole('row', { name: /Term 100/ }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('(1 needs comp rules)')).toBeVisible();
  await page.locator('#products').screenshot({ path: 'test-results/products-and-comp.png' });

  await page.getByRole('button', { name: 'Reports' }).click();
  await page.getByRole('button', { name: 'This month' }).click();
  // Profit is off Reports for now (lead cost isn't accurate yet); the commission math stays and is tested on the server.
  await expect(page.getByRole('heading', { name: /^By lead type/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Profit/ })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Net' })).toHaveCount(0);
});
