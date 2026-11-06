import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The daily routine: the steps above the call list, the next one offered when the list runs out, Settings, and a
// step saved from the Leads page.

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

test('work the day by routine: imports, then a step saved from Leads', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();

  // Import without putting the leads on the list: the routine's imports step does that.
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const file = path.join(dataDir, 'Morning leads.csv');
  fs.copyFileSync('test/fixtures/sample-leads.csv', file);
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(file);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Check them now' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.getByLabel('Add these leads to the call list').uncheck();
  await page.getByRole('button', { name: 'Import 4 leads' }).click();
  await expect(page.getByText('Import finished')).toBeVisible();

  // Calling: the starter routine, with the imports step offered first since there are no no-shows.
  await nav('Calling');
  const routine = page.getByLabel("Today's routine");
  await expect(routine).toContainText('Every day');
  await expect(routine.locator('.routine-step')).toHaveText([/1\. No-shows\s+0/, /2\. Today's imports\s+4/, /3\. Today's no-answers\s+0/]);
  await expect(routine.getByRole('status')).toContainText("Next: Today's imports (4 to call)");
  await routine.getByRole('status').getByRole('button', { name: 'Start' }).click();
  await page.getByRole('dialog', { name: "Start: Today's imports" }).getByRole('button', { name: 'Start' }).click();
  await expect(page.getByLabel('Queue').locator('.queue-list li')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/routine-calling.png' });

  // A no answer counts toward the step.
  const first = await page.locator('.lead-name').innerText();
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText(`Saved for ${first}`);
  await expect(routine.getByRole('button', { name: /Today's imports/ })).toContainText('1/4 called');

  // Leads: no answers called today, saved as a step of today's routine.
  await nav('Leads');
  await page.getByRole('button', { name: 'No answer', exact: true }).click();
  await page.getByLabel('Last call', { exact: true }).selectOption('today');
  await expect(page.getByText('1 lead', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save as routine step' }).click();
  const save = page.getByRole('dialog', { name: 'Save as routine step' });
  await expect(save).toContainText('No answer · Last call today');
  await save.getByLabel('Step name').fill('Quick no-answers');
  await save.getByRole('button', { name: 'Save step' }).click();
  await expect(save).toHaveCount(0);

  // Settings: the step is at the end; move it up one.
  await nav('Settings');
  const card = page.getByLabel('Routine Every day');
  await expect(card.getByLabel('Step name')).toHaveCount(4);
  await expect(card.getByLabel('Step name').nth(3)).toHaveValue('Quick no-answers');
  await card.getByRole('button', { name: 'Move Quick no-answers up' }).click();
  await expect(card.getByLabel('Step name').nth(2)).toHaveValue('Quick no-answers');
  await page.getByRole('heading', { name: 'Routines' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/routine-settings.png' });

  // Back on Calling it's step 3, and starting it puts the lead back under the list to call.
  await nav('Calling');
  const step = routine.getByRole('button', { name: /Quick no-answers/ });
  await expect(step).toContainText('3. Quick no-answers 1');
  await step.click();
  const dialog = page.getByRole('dialog', { name: 'Start: Quick no-answers' });
  await expect(dialog).toContainText('1 lead to call.');
  await dialog.getByLabel('Add them under the call list').check();
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByLabel('Queue')).toContainText('4 to call · 0 done');
});
