import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeLeadPdf, FAKE } from '../pdfFixtures.js';

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

test.afterAll(() => {
  server?.kill('SIGTERM');
});

function leadCsv(n: number, offset: number) {
  const lines = ['Name,Phone,Address,City,State,Zip,County'];
  for (let k = 0; k < n; k++) {
    const i = k + offset;
    lines.push(`Person${i} Tester,(317) ${200 + (i % 700)}-${String(Math.floor(i / 700)).padStart(4, '0')},${100 + i} Main St,Indianapolis,IN,46204,Marion`);
  }
  return lines.join('\n');
}

test('import a whole folder of lead files in one go', async ({ page }) => {
  // A folder like a download folder: sheets, a PDF, a repeat, and things that aren't leads.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-folder-'));
  fs.mkdirSync(path.join(folder, 'october'));
  fs.writeFileSync(path.join(folder, 'week1.csv'), leadCsv(300, 0));
  fs.writeFileSync(path.join(folder, 'october', 'week2.csv'), leadCsv(200, 250)); // 50 repeat week1
  fs.writeFileSync(path.join(folder, 'october', 'odd.csv'), 'Foo,Bar\nx,y\n');
  fs.writeFileSync(path.join(folder, 'IN_574_1-2.pdf'), await makeLeadPdf([FAKE[0]!, FAKE[1]!]));
  fs.writeFileSync(path.join(folder, 'readme.docx'), 'not a lead file');

  await page.goto(launchUrl);
  // The empty call list has its own Import button too; use the one in the top bar.
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(folder);
  await expect(page.getByRole('heading', { name: 'Import 4 files' })).toBeVisible();
  await expect(page.getByText('1 other file was left out')).toBeVisible();
  await page.getByRole('button', { name: 'Start importing' }).click();

  await expect(page.getByText('Done.')).toBeVisible({ timeout: 30_000 });
  const tiles = page.locator('.summary-tiles');
  await expect(tiles.getByText('leads imported')).toBeVisible();
  // 300 + 200 - 50 repeats + 2 from the PDF.
  await expect(tiles.locator('div', { hasText: 'leads imported' }).locator('b')).toHaveText('452');
  await expect(tiles.locator('div', { hasText: 'repeats skipped' }).locator('b')).toHaveText('50');
  await expect(page.getByText("columns couldn't be matched").first()).toBeVisible();
  await page.screenshot({ path: path.join(process.env.SHOT_DIR ?? os.tmpdir(), 'bulk-import-done.png'), fullPage: true });

  // Straight to just these leads on the Leads page, then back.
  await page.getByRole('button', { name: 'See the 452 imported leads' }).click();
  await expect(page.getByText('452 leads', { exact: false }).first()).toBeVisible();
  await expect(page.getByLabel('Batch')).toHaveText(/^Bulk import · 4 files/);
  // The batch picker: search narrows it, and the bulk import opens to show its files.
  await page.getByLabel('Batch').click();
  const pop = page.getByRole('dialog', { name: 'Pick a batch' });
  await pop.getByRole('button', { name: 'Show files' }).click();
  await expect(pop.locator('.pick-item.indent')).not.toHaveCount(0);
  await page.screenshot({ path: path.join(process.env.SHOT_DIR ?? os.tmpdir(), 'batch-picker.png') });
  await pop.getByLabel('Search batches').fill('zzz no such batch');
  await expect(pop.getByText('No batches match.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();

  await page.getByRole('button', { name: 'Need you (1)' }).click();
  await expect(page.locator('table.grid tbody tr')).toHaveCount(1);

  // Back on the Import page, the run is listed.
  await page.getByRole('button', { name: 'Back to Import' }).click();
  const history = page.locator('.card', { has: page.getByRole('heading', { name: /Past imports/ }) });
  await expect(history.locator('tr.group-row', { hasText: 'Bulk import · 4 files' })).toBeVisible();
  await history.getByRole('button', { name: 'Show files' }).click();
  await expect(history.locator('tr.child-row')).not.toHaveCount(0);
  await page.screenshot({ path: path.join(process.env.SHOT_DIR ?? os.tmpdir(), 'past-imports.png'), fullPage: true });

  // Reports by batch: the bulk import is one line, and columns sort.
  await page.getByRole('button', { name: 'Reports' }).click();
  const byBatch = page.locator('.card', { has: page.getByRole('heading', { name: /By batch/ }) });
  await expect(byBatch.locator('tr.group-row', { hasText: 'Bulk import' })).toBeVisible();
  await byBatch.getByRole('button', { name: 'Sort by Leads' }).click();
  await expect(byBatch.getByRole('button', { name: 'Sort by Leads' })).toHaveText('Leads ▾');
  await byBatch.getByRole('button', { name: 'Show files' }).click();
  await expect(byBatch.locator('tr.child-row')).not.toHaveCount(0);
});
