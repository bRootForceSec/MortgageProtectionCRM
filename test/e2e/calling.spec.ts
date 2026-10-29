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
  // The window title names the open lead by last name, and goes back to normal off the Calling screen.
  await expect(page).toHaveTitle(`MPCRM - ${first.trim().split(/\s+/).pop()}`);
  await page.locator('.topbar nav').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveTitle('Calling CRM');
  await expect(page.getByRole('heading', { name: 'Version and updates' })).toBeVisible();
  await page.locator('.topbar nav').getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(page.locator('.lead-name')).toHaveText(first);
  await expect(page.getByLabel('Queue').locator('.queue-list li')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/calling.png', fullPage: true });

  // Talked, no appt: press 2 then Enter. Enter saves and moves straight on to the next lead.
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText(`Saved for ${first}`);
  await expect(page.locator('.undo-bar')).toContainText('Talked, no appt');
  await expect(page.locator('.lead-name')).not.toHaveText(first);
  const second = await page.locator('.lead-name').innerText();
  await expect(page.locator('.topbar .stats')).toContainText('Leads called 1');
  await expect(page.locator('.topbar .stats')).toContainText('Pickups 1');
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

  // Edit the lead's name, and give it two more numbers.
  await page.keyboard.press('e');
  const edit = page.getByRole('dialog', { name: 'Edit lead' });
  await expect(edit).toBeVisible();
  await page.getByLabel('First name').fill('Zed');
  for (const [i, [n, label]] of [['317-555-0161', 'Work'], ['317-555-0162', 'Spouse']].entries()) {
    await edit.getByRole('button', { name: 'Add a number' }).click();
    await edit.getByLabel(`Other number ${i + 1}`, { exact: true }).fill(n!);
    await edit.getByLabel(`Other number ${i + 1} label`).fill(label!);
  }
  await page.screenshot({ path: 'test-results/edit-other-numbers.png' });
  await edit.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.lead-name')).toContainText('Zed');
  await expect(page.locator('.phones')).toContainText('Work');
  await expect(page.locator('.phones')).toContainText('(317) 555-0162');
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

test('the funnel button on the Calling screen shows the animated funnel', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await page.getByRole('button', { name: 'Show my funnel' }).click();
  const dialog = page.getByRole('dialog', { name: 'My funnel' });
  await expect(dialog.getByRole('img', { name: /Funnel/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'All time' }).click();
  await page.waitForTimeout(1800); // let the numbers count up
  await dialog.screenshot({ path: 'test-results/funnel.png' });
  // Keys go to the funnel, not the Calling screen, and Escape closes it.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.phone-big')).toBeVisible();
});

test('fix the lead type on every lead in a batch, and see it by lead type in Reports', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByLabel('Batch').click();
  await page.getByRole('dialog', { name: 'Pick a batch' }).locator('.pick-item').nth(1).click();
  const count = page.locator('.leads-tools .muted').first();
  await expect(count).not.toHaveText(/^0 leads/);
  const total = Number((await count.innerText()).match(/\d+/)![0]);
  await page.getByRole('button', { name: 'Change lead type' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change lead type' });
  await dialog.getByLabel('New lead type').selectOption('C');
  await dialog.getByRole('button', { name: `Change ${total} lead${total === 1 ? '' : 's'}` }).click();
  await expect(page.getByText(/leads? changed to/)).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('Lead type', { exact: true }).selectOption('C');
  await expect(count).toHaveText(new RegExp(`^${total} lead`));

  await page.getByRole('button', { name: 'Reports' }).click();
  const byType = page.locator('.card', { has: page.getByRole('heading', { name: /By lead type/ }) });
  await expect(byType.locator('tbody tr', { hasText: /^C\b/ }).locator('td').nth(1)).toHaveText(String(total));
  await byType.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/reports-by-lead-type.png' });
});

test('leads open full screen like the Calling page, and step through the list', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  const rows = page.locator('table.grid tbody tr');
  await expect(rows.first()).toBeVisible();
  // Every lead is in one lead-age band, or has no call-in date; the filter narrows the list.
  const all = await rows.count();
  const totals = await page.evaluate(async () => {
    const n = async (q: string) => (await (await fetch(`/api/leads${q}`)).json()).total as number;
    return { all: await n(''), bands: await Promise.all(['0_7', '8_30', '31_90', 'older', 'unknown'].map((b) => n(`?age=${b}`))) };
  });
  expect(totals.bands.reduce((a, b) => a + b, 0)).toBe(totals.all);
  const shown = page.waitForResponse((r) => r.url().includes('/api/leads?') && r.url().includes('age=unknown'));
  await page.getByLabel('Lead age').selectOption('unknown');
  await shown;
  await page.getByLabel('Lead age').selectOption('');
  await expect(rows).toHaveCount(all);
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

test('Do not call is a tick beside the outcome, toggled with D', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(page.locator('.phone-big')).toBeVisible();
  const lead = await page.locator('.lead-name').innerText();
  await page.keyboard.press('d');
  await expect(page.getByLabel('Do not call')).toBeChecked();
  await page.keyboard.press('d');
  await expect(page.getByLabel('Do not call')).not.toBeChecked();
  // D, then 2 and Enter: Talked, no appt with the tick. The lead goes to the dead pile.
  await page.keyboard.press('d');
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('Talked, no appt, do not call');
  await expect(page.getByLabel('Do not call')).not.toBeChecked();
  await expect(page.locator('.lead-name')).not.toHaveText(lead);
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.lead-name')).toHaveText(lead);
  await expect(page.getByText('Asked not to be called again. This lead is in the dead pile.')).toBeVisible();
  await expect(page.getByLabel('History').getByText('do not call')).toBeVisible();
});

test('First call | Appointment: an appointment set opens on the Appointment side; a prezi goes back to be called', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(page.locator('.lead-panel')).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Kind of call' });
  const lookUp = async (who: string) => {
    await page.keyboard.press('l');
    await page.keyboard.type(who);
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lead-name')).toHaveText(who);
  };
  // Ann Lee had an appointment set earlier: she opens on the Appointment side.
  await lookUp('Ann Lee');
  await expect(tabs.getByRole('tab', { name: 'Appointment' })).toHaveAttribute('aria-selected', 'true');
  const outcomes = page.getByRole('group', { name: 'Appointment outcome' });
  await expect(outcomes.getByRole('button')).toHaveText([/No show/, /Sat, no sale/, /Prezi/, /Sale/, /Rescheduled/]);
  // M flips the side, and back.
  await page.keyboard.press('m');
  await expect(tabs.getByRole('tab', { name: 'First call' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('group', { name: 'Outcome', exact: true })).toContainText('No answer');
  await page.keyboard.press('m');
  await expect(outcomes).toBeVisible();
  await page.screenshot({ path: 'test-results/appointment-side.png', fullPage: true });
  // 3, Enter: Prezi. She comes back to be called, tagged as a prezi, on the First call side.
  await page.keyboard.press('3');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('Prezi');
  await lookUp('Ann Lee');
  await expect(page.getByLabel('Current lead').locator('.badge.appt-prezi')).toHaveText('Prezi, no sale');
  await expect(tabs.getByRole('tab', { name: 'First call' })).toHaveAttribute('aria-selected', 'true');
});

test('call history: change the caller ID on ticked calls', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Numbers' }).click();
  await page.getByPlaceholder('(614) 555-0199').fill('614-555-0188');
  await page.getByPlaceholder('e.g. Sideline').fill('Office');
  await page.getByRole('button', { name: 'Add number' }).click();
  await expect(page.getByRole('cell', { name: '(614) 555-0188' })).toBeVisible();

  await page.getByRole('button', { name: 'Call history' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Sideline (614) 555-0199' }).nth(1)).toBeVisible();
  // Tick the first and shift-click the second: both are ticked.
  await page.getByRole('checkbox', { name: /^Tick the call to/ }).nth(0).click();
  await page.getByRole('checkbox', { name: /^Tick the call to/ }).nth(1).click({ modifiers: ['Shift'] });
  await page.getByLabel('New caller ID').selectOption({ label: 'Office (614) 555-0188' });
  await page.screenshot({ path: 'test-results/change-caller-id.png', fullPage: true });
  await page.getByRole('button', { name: 'Change 2 ticked' }).click();
  await expect(page.locator('.toast')).toContainText('Caller ID changed to Office (614) 555-0188 on 2 calls');
  await expect(page.getByRole('row').filter({ hasText: 'Office (614) 555-0188' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Change/ })).toBeDisabled();
  // The caller ID filter shows only the calls from that number.
  await page.getByLabel('Only calls from').selectOption({ label: 'Office (614) 555-0188' });
  await expect(page.getByRole('checkbox', { name: /^Tick the call to/ })).toHaveCount(2);
});

test('narrow windows: the lead and its outcome buttons come first, nothing runs off the side', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(page.locator('.phone-big')).toBeVisible();
  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  for (const [width, height] of [[960, 1040], [480, 700]] as const) {
    await page.setViewportSize({ width, height });
    // The outcome buttons are on screen without scrolling, and the page is no wider than the window.
    await expect(page.getByRole('group', { name: 'Outcome' }).getByRole('button', { name: /No answer/ })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const lead = await box('.lead-panel');
    expect(lead.width).toBeGreaterThan(width * 0.6 - 40);
  }
  // Side by side at half a big screen; stacked with the lead on top when narrower.
  await page.setViewportSize({ width: 960, height: 1040 });
  expect((await box('.queue-panel')).x).toBeLessThan((await box('.lead-panel')).x);
  await page.setViewportSize({ width: 480, height: 700 });
  expect((await box('.lead-panel')).y).toBeLessThan((await box('.queue-panel')).y);
});
