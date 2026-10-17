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

  // Voicemail left: press 2 then Enter. Enter saves and moves straight on to the next lead.
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText(`Saved for ${first}`);
  await expect(page.locator('.undo-bar')).toContainText('Voicemail, message left');
  await expect(page.locator('.lead-name')).not.toHaveText(first);
  const second = await page.locator('.lead-name').innerText();
  await expect(page.locator('.topbar .stats')).toContainText('Calls 1');
  // The worked lead stays in the list, greyed out.
  await expect(page.getByLabel('Queue').locator('li')).toHaveCount(4);
  await expect(page.getByLabel('Queue').locator('li.done')).toHaveCount(1);

  // Up arrow goes back to it and shows the call; down comes back.
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.lead-name')).toHaveText(first);
  await expect(page.getByLabel('History').getByText('Voicemail, message left')).toBeVisible();
  await expect(page.getByLabel('History').getByText('from Sideline')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lead-name')).toHaveText(second);

  // Do-not-call request → dead pile (confirm dialog auto-accepted), then on to the next lead.
  await page.keyboard.press('d');
  await expect(page.getByRole('button', { name: /Do-not-call request/ })).toHaveClass(/active/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.lead-name')).not.toHaveText(second);
  await expect(page.getByLabel('Queue')).toContainText('2 to go · 2 done');
  await expect(page.getByLabel('Queue').locator('li')).toHaveCount(4);
  await page.keyboard.press('ArrowUp');
  await expect(page.getByText('This lead is in the dead pile.')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lead-name')).not.toHaveText(second);
  const current = await page.locator('.lead-name').innerText();

  // The dead pile lists it.
  await page.getByRole('button', { name: 'Leads' }).click();
  await page.getByRole('button', { name: 'Dead pile' }).click();
  await expect(page.locator('table.grid tbody tr')).toHaveCount(1);
  await expect(page.locator('table.grid tbody tr')).toContainText(second);

  // Refresh keeps the list and the selected lead.
  await page.getByRole('button', { name: 'Calling' }).click();
  await page.reload();
  await expect(page.locator('.lead-name')).toHaveText(current);
  await expect(page.getByLabel('Queue').locator('li.done')).toHaveCount(2);
});

test('dial counter, undo, remapped keys, QR dialing, scripts and lead edits', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling' }).click();
  await expect(page.locator('.phone-big')).toBeVisible();
  const lead = await page.locator('.lead-name').innerText();

  // Two dials back to back, no answer: → → then ← takes one off.
  const counter = page.getByLabel('Dials this attempt');
  await expect(counter).toContainText('1 dial');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(counter).toContainText('3 dials');
  await page.keyboard.press('<');
  await expect(counter).toContainText('2 dials');
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('No answer · 2 dials');
  await expect(page.locator('.lead-name')).not.toHaveText(lead);
  await expect(page.locator('.topbar .stats')).toContainText('Dials 4');

  // Undo goes back to that lead and puts the outcome back to fix.
  await page.keyboard.press('z');
  await expect(page.locator('.lead-name')).toHaveText(lead);
  await expect(page.getByLabel('History').getByText(/^Undone/)).toBeVisible();
  await expect(counter).toContainText('2 dials');
  await expect(page.getByRole('button', { name: /No answer/ })).toHaveClass(/active/);
  await expect(page.locator('.topbar .stats')).toContainText('Dials 2');
  await page.keyboard.press('Escape');
  await page.keyboard.press('3');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('Voicemail, no message · 2 dials');
  await expect(page.locator('.lead-name')).not.toHaveText(lead);
  const next = await page.locator('.lead-name').innerText();

  // Settings: "next" moves to J, dialing shows a QR code, a script and a daily goal.
  await page.getByRole('button', { name: 'Settings' }).click();
  const nextRow = page.locator('table.shortcuts tr', { hasText: 'Next lead' });
  await nextRow.locator('.keycap').first().click();
  await expect(nextRow).toContainText('press a key');
  await page.keyboard.press('j');
  await expect(nextRow.locator('.keycap').first()).toHaveText('J');
  await page.getByText('Show a QR code').click();
  await page.getByLabel('Your name, as you say it on calls').fill('Alex');
  await page.getByLabel('Opener').fill('Hi {first_name}, this is {agent_name} about your {lender} mortgage.');
  await page.getByRole('button', { name: 'Save scripts' }).click();
  await page.locator('.settings-grid').getByText('Dials').locator('input').fill('200');
  await page.locator('.settings-grid').getByText('Dials').locator('input').blur();
  await expect(page.locator('.topbar .stats')).toContainText('/ 200');
  await page.screenshot({ path: 'test-results/settings.png', fullPage: true });

  await page.getByRole('button', { name: 'Calling' }).click();
  await expect(page.locator('.lead-name')).toHaveText(next);
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'Scan to dial' }).locator('canvas')).toBeVisible();
  await page.screenshot({ path: 'test-results/qr.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.timer')).toBeVisible();

  await page.keyboard.press('p');
  await expect(page.locator('.card.script')).toContainText(`this is Alex about your`);

  // Edit the lead's name.
  await page.keyboard.press('e');
  await expect(page.getByRole('dialog', { name: 'Edit lead' })).toBeVisible();
  await page.getByLabel('First name').fill('Zed');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.lead-name')).toContainText('Zed');
  await expect(page.locator('.card.script')).toContainText('Hi Zed,');
  await page.screenshot({ path: 'test-results/calling-refined.png', fullPage: true });

  // J is now "next": every other lead in this list has been worked, so it says so.
  await page.keyboard.press('j');
  await expect(page.getByText(/worked the whole list/)).toBeVisible();

  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
});

test('API refuses requests without the access cookie', async ({ request }) => {
  const r = await request.get(`http://127.0.0.1:${PORT}/api/meta`);
  expect(r.status()).toBe(401);
});
