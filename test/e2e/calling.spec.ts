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

test('import a sheet, log calls by keyboard, and set a callback', async ({ page }) => {
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
  // The file picker, not the folder picker next to it.
  await page.locator('input[type=file]:not([webkitdirectory])').setInputFiles(file);
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
  // New imports go straight onto the call list (ticked by default).
  await expect(page.getByLabel('Add these leads to the call list')).toBeChecked();
  await page.getByRole('button', { name: 'Import 4 leads' }).click();
  await expect(page.getByText('Import finished')).toBeVisible();
  await expect(page.getByText('4 leads added to your call list')).toBeVisible();
  await page.getByRole('button', { name: 'Start calling' }).click();

  // Calling screen: first lead is selected and shows the phone.
  await expect(page.locator('.phone-big')).toBeVisible();
  const first = await page.locator('.lead-name').innerText();
  await expect(page.getByLabel('Queue').locator('.queue-list li')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/calling.png', fullPage: true });

  // Talked, no appt: press 2 then Enter. Enter saves and moves straight on to the next lead.
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText(`Saved for ${first}`);
  await expect(page.locator('.undo-bar')).toContainText('Talked, no appt');
  await expect(page.locator('.lead-name')).not.toHaveText(first);
  const second = await page.locator('.lead-name').innerText();
  await expect(page.locator('.topbar .stats')).toContainText('Calls 1');
  // The worked lead stays in the list, greyed out.
  await expect(page.getByLabel('Queue').locator('.queue-list li')).toHaveCount(4);
  await expect(page.getByLabel('Queue').locator('.queue-list li.done')).toHaveCount(1);

  // Up arrow goes back to it and shows the call; down comes back.
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.lead-name')).toHaveText(first);
  await expect(page.getByLabel('History').getByText('Talked, no appt')).toBeVisible();
  await expect(page.getByLabel('History').getByText('from Sideline')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lead-name')).toHaveText(second);

  // Callback: 5 opens the picker on "tomorrow"; a blank time means any time that day.
  await page.keyboard.press('5');
  await expect(page.locator('#callback-day')).toBeFocused();
  await expect(page.locator('#callback-day')).toHaveValue('tomorrow');
  await expect(page.locator('.callback-picker')).toContainText(/Tomorrow, .*any time/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('Callback');
  await expect(page.locator('.lead-name')).not.toHaveText(second);

  // Undo brings the lead back with the callback filled in; change it to Friday at 2 and save again.
  await page.keyboard.press('z');
  await expect(page.locator('.lead-name')).toHaveText(second);
  await expect(page.getByRole('group', { name: 'Outcome' }).getByRole('button', { name: /Callback/ })).toHaveClass(/active/);
  await expect(page.locator('.callback-picker')).toContainText(/Tomorrow, .*any time/);
  await page.locator('#callback-day').fill('fri');
  await page.locator('#callback-time').fill('2');
  await expect(page.locator('.callback-picker')).toContainText(/Fri.* at 2:00/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.lead-name')).not.toHaveText(second);
  await expect(page.getByLabel('Queue')).toContainText('2 to call · 2 done');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByLabel('History').getByText(/call back \w+ \d+, 2:00 PM/)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lead-name')).not.toHaveText(second);
  const current = await page.locator('.lead-name').innerText();

  // Refresh keeps the list and the selected lead.
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await page.reload();
  await expect(page.locator('.lead-name')).toHaveText(current);
  await expect(page.getByLabel('Queue').locator('.queue-list li.done')).toHaveCount(2);
});

test('dial counter, undo, remapped keys, QR dialing, scripts and lead edits', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
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
  // No answer saves on its own key, without Enter.
  await page.keyboard.press('1');
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
  await expect(page.locator('.undo-bar')).toContainText('Appt set · 2 dials');
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

  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(page.locator('.lead-name')).toHaveText(next);
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'Scan to dial' }).locator('canvas')).toBeVisible();
  await page.screenshot({ path: 'test-results/qr.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.timer')).toBeVisible();

  // X dials the lead's other number; this one has none.
  await page.keyboard.press('x');
  await expect(page.getByText('This lead has no other working number')).toBeVisible();

  await page.keyboard.press('p');
  await expect(page.locator('.card.script')).toContainText(`this is Alex about your`);

  // Edit the lead's name.
  await page.keyboard.press('e');
  await expect(page.getByRole('dialog', { name: 'Edit lead' })).toBeVisible();
  await page.getByLabel('First name').fill('Zed');
  await page.getByRole('dialog', { name: 'Edit lead' }).getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.lead-name')).toContainText('Zed');
  await expect(page.locator('.card.script')).toContainText('Hi Zed,');
  await page.screenshot({ path: 'test-results/calling-refined.png', fullPage: true });

  // J is now "next": every other lead in this list has been worked, so it says so.
  await page.keyboard.press('j');
  await expect(page.getByText(/worked the whole list/)).toBeVisible();

  await page.getByRole('button', { name: 'Callbacks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Callbacks' })).toBeVisible();
  await expect(page.getByText('Coming up (next two weeks)')).toBeVisible();
});

test('clear worked leads, add more from Leads, and look up an incoming call without losing the list', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(page.locator('.phone-big')).toBeVisible();
  const queue = page.getByLabel('Queue');

  // Worked leads stay until you clear them.
  await expect(queue.locator('.queue-list li.done')).toHaveCount(3);
  await queue.getByRole('button', { name: 'Clear worked' }).click();
  await expect(queue.locator('.queue-list li')).toHaveCount(1);
  await expect(queue.locator('.queue-list li.done')).toHaveCount(0);

  // Pick leads on the Leads page: everyone talked to before (no appointment), ticked and added to the bottom of the list.
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'Talked, no appt', exact: true }).click();
  await page.getByLabel('Tick every lead shown').check();
  const add = page.getByRole('button', { name: /^Add \d+ ticked to call list$/ });
  const n = Number((await add.innerText()).match(/\d+/)![0]);
  expect(n).toBeGreaterThan(0);
  await add.click();
  await expect(page.getByText(`${n} lead${n === 1 ? '' : 's'} added to the call list`)).toBeVisible();
  await expect(page.locator('table.grid tbody').getByText('on call list')).toHaveCount(n);
  await page.screenshot({ path: 'test-results/leads-pick.png' });

  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(queue.locator('.queue-list li')).toHaveCount(n + 1);
  const current = await page.locator('.lead-name').innerText();
  const rows = n + 1;

  // L jumps to the lookup box; part of the number finds the lead, any status. Enter opens the top match.
  await page.keyboard.press('l');
  await expect(page.getByLabel('Look up a caller by phone number')).toBeFocused();
  await page.keyboard.type('614 555 0102');
  await expect(page.locator('.lookup-results li').first()).toContainText('Robert Ray');
  await page.keyboard.press('Enter');
  await expect(page.locator('.lead-name')).toHaveText('Robert Ray');
  await expect(page.locator('.lookup-bar')).toContainText('Your list on the left is unchanged');
  await expect(queue.locator('.queue-list li')).toHaveCount(rows);
  await page.screenshot({ path: 'test-results/lookup.png', fullPage: true });

  // Same outcome keys as always; saving goes back to where you were in the list.
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('Saved for Robert Ray');
  await expect(page.locator('.lead-name')).toHaveText(current);
  await expect(page.locator('.lookup-bar')).toHaveCount(0);
  await expect(queue.locator('.queue-list li')).toHaveCount(rows);

  // Work the current lead, then leave the tab: the crossed-out lead is still there, and in Recent outcomes.
  const doneBefore = await queue.locator('.queue-list li.done').count();
  await page.keyboard.press('1');
  await expect(queue.locator('.queue-list li.done')).toHaveCount(doneBefore + 1);
  await page.getByRole('button', { name: 'Callbacks', exact: true }).click();
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(queue.locator('.queue-list li.done')).toHaveCount(doneBefore + 1);
  await expect(queue.locator('.queue-list li.done', { hasText: current })).toHaveCount(1);
  await expect(page.locator('.recent')).toContainText('Robert Ray');
  await page.screenshot({ path: 'test-results/call-list.png' });
});

test('reports: numbers open the calls behind them', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  const dials = page.locator('.summary-tiles div', { hasText: 'Dials' }).first().locator('button.num');
  await expect(dials).not.toHaveText('0');
  const attempts = await page.locator('.summary-tiles div', { hasText: 'Attempts' }).first().locator('button.num').innerText();
  await page.locator('.summary-tiles div', { hasText: 'Attempts' }).first().locator('button.num').click();
  const dialog = page.getByRole('dialog', { name: 'Attempts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('tbody tr')).toHaveCount(Number(attempts));
  await page.screenshot({ path: 'test-results/reports-drill.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Local vs out-of-area caller ID' })).toBeVisible();
  await page.getByRole('heading', { name: 'Local vs out-of-area caller ID' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/reports-caller-id.png' });
  await expect(page.getByRole('heading', { name: /By batch/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /benchmarks/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/reports.png', fullPage: true });
});

test('leads open full screen like the Calling page, and step through the list', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  const rows = page.locator('table.grid tbody tr');
  await expect(rows.first()).toBeVisible();
  const first = (await rows.nth(0).locator('td').nth(1).innerText()).trim();
  const second = (await rows.nth(1).locator('td').nth(1).innerText()).trim();
  await rows.first().click();

  const viewer = page.getByRole('dialog', { name: 'Lead' });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.lead-name')).toHaveText(first);
  await expect(viewer.getByLabel('Lead list').locator('.queue-list li.selected')).toContainText(first);
  // The page the lead came from, with the same zoom tools as Calling; no outcome buttons.
  await expect(viewer.getByLabel('Lead page').getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(viewer.locator('.outcomes')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/lead-viewer.png' });

  await page.keyboard.press('ArrowDown');
  await expect(viewer.locator('.lead-name')).toHaveText(second);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Call now takes the lead to the Calling page.
  await rows.nth(1).click();
  await expect(viewer.locator('.lead-name')).toHaveText(second);
  const callNow = viewer.getByRole('button', { name: 'Call now' });
  await callNow.click();
  await expect(page.getByLabel('Queue')).toBeVisible();
  await expect(page.getByLabel('Current lead').locator('.lead-name')).toHaveText(second);
});

test('API refuses requests without the access cookie', async ({ request }) => {
  const r = await request.get(`http://127.0.0.1:${PORT}/api/meta`);
  expect(r.status()).toBe(401);
});

test('clear the call list into a saved list, load it back, and replace it from Leads', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  const queue = page.getByLabel('Queue');
  await expect(queue.locator('.queue-list li').first()).toBeVisible();
  const n = await queue.locator('.queue-list li').count();
  expect(n).toBeGreaterThan(0);

  // Clear it, keeping it as a saved list (ticked by default).
  await queue.getByRole('button', { name: 'Clear list' }).click();
  await page.getByLabel('Saved list name').fill('Old area');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear list' }).click();
  await expect(page.getByText('"Old area" is in Saved lists.')).toBeVisible();
  await expect(page.getByText('Your call list is empty.')).toBeVisible();

  // Load it back: same leads, and it carries its name.
  await queue.getByRole('button', { name: 'Saved lists (1)' }).click();
  await expect(page.getByText(`of ${n} left to call`)).toBeVisible();
  await page.getByRole('button', { name: 'Load Old area' }).click();
  await expect(queue.locator('.queue-list li')).toHaveCount(n);
  await expect(queue.getByText('List: Old area')).toBeVisible();

  // Replace it from Leads with every lead talked to before (no appointment), keeping the old one.
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'Talked, no appt', exact: true }).click();
  await page.getByLabel(/Replace the call list/).check();
  await page.getByRole('button', { name: /^Replace with all \d+ matching$/ }).click();
  await expect(page.getByLabel('Saved list name')).toHaveValue('Old area');
  await page.screenshot({ path: 'test-results/replace-list.png' });
  await page.getByRole('button', { name: 'Replace call list' }).click();
  await expect(page.getByText(/^Call list replaced/)).toBeVisible();

  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await queue.getByRole('button', { name: 'Saved lists (1)' }).click();
  await expect(page.getByRole('dialog', { name: 'Saved lists' }).getByText('Old area')).toBeVisible();
  await page.screenshot({ path: 'test-results/saved-lists.png' });
});

test('"called me back": one key on the Calling screen, or the tick on any lead page', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  const queue = page.getByLabel('Queue');
  await expect(page.locator('.phone-big')).toBeVisible();
  const name = (await page.locator('.lead-name').innerText()).trim();
  const tick = page.getByLabel(/Called me back/);
  await expect(tick).not.toBeChecked();
  await page.keyboard.press('b');
  await expect(tick).toBeChecked();
  await expect(page.getByText(`${name} called you back ✓`)).toBeVisible();
  await expect(queue.locator('li.selected').getByText('✓ called back')).toBeVisible();
  await page.screenshot({ path: 'test-results/called-back.png' });
  await page.keyboard.press('b');
  await expect(tick).not.toBeChecked();
  await expect(queue.locator('li.selected').getByText('✓ called back')).toHaveCount(0);

  // On the Leads page lead view, the tick works too and shows back on the Calling screen.
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.locator('table.grid tbody tr', { hasText: name }).first().click();
  const viewer = page.getByRole('dialog', { name: 'Lead' });
  await viewer.getByLabel(/Called me back/).check();
  await expect(viewer.getByLabel(/Called me back/)).toBeChecked();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(queue.locator('li', { hasText: name }).getByText('✓ called back')).toBeVisible();
});
