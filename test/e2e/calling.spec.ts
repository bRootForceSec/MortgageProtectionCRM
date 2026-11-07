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

test.afterAll(async () => {
  // Once the server has stopped, its data folder goes, so runs don't fill the disk.
  if (server && server.exitCode === null) {
    await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); setTimeout(r, 5000); });
  }
  // Best-effort: Windows won't delete a file a server that didn't stop in time still has open.
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

test('import a sheet, log calls by keyboard, and start an Appt set', async ({ page }) => {
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
  await page.locator('.topbar nav').getByRole('button', { name: 'Import', exact: true }).click();
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

  // Dial: Picked up: press 2, then Shift+1 for the Price objection (optional), then Enter. Enter saves and moves straight on to the next lead.
  await page.keyboard.press('2');
  const objections = page.getByRole('group', { name: 'Objections' });
  await expect(objections.getByRole('button')).toHaveText([/Price/, /Spouse/, /Already covered/, /Think about it/, /Health/, /Trust/, /Other/]);
  await page.keyboard.press('Shift+Digit1');
  await expect(objections.getByRole('button', { name: /Price/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText(`Saved for ${first}`);
  await expect(page.locator('.undo-bar')).toContainText('Dial: Picked up');
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
  await expect(page.getByLabel('History').getByText('Dial: Picked up')).toBeVisible();
  await expect(page.getByLabel('History').getByText('from Sideline')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.lead-name')).toHaveText(second);

  // Callback has no button any more, so 5 does nothing on the First call side.
  const firstSide = page.getByRole('group', { name: 'Outcome' }).getByRole('button');
  await expect(firstSide).toHaveText([/Dial: No answer/, /Dial: Picked up/, /Dial: Appt set/, /Dial: Bad number/]);
  await page.keyboard.press('5');
  await expect(page.locator('#callback-day')).toHaveCount(0);

  // Appt set: 3 asks for the day, with the calendar text one click away. Changed my mind: 1 saves No answer instead.
  await page.keyboard.press('3');
  await expect(page.locator('#callback-day')).toBeFocused();
  await expect(page.getByRole('button', { name: /^Copy #MP/ }).first()).toBeVisible();
  await page.locator('#callback-day').blur();
  await page.keyboard.press('1');
  await expect(page.locator('.undo-bar')).toContainText('Dial: No answer');
  await expect(page.locator('.lead-name')).not.toHaveText(second);
  await expect(page.getByLabel('Queue')).toContainText('2 to call · 2 done');
  const current = await page.locator('.lead-name').innerText();

  // Refresh keeps the list and the selected lead.
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await page.reload();
  await expect(page.locator('.lead-name')).toHaveText(current);
  await expect(page.getByLabel('Queue').locator('.queue-list li.done')).toHaveCount(2);

});

test('dial counter, undo, remapped keys, QR dialing and lead edits', async ({ page }) => {
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
  await expect(page.locator('.undo-bar')).toContainText('Dial: No answer · 2 dials');
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
  // Appt set offers the appointment's day and time (optional). Type tomorrow at 2, then Enter.
  await page.keyboard.press('3');
  await expect(page.getByLabel('Appointment on (optional)')).toBeFocused();
  await page.keyboard.type('m');
  await page.getByLabel(/^At \(optional/).fill('2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('Appt set · 2 dials');
  await expect(page.locator('.lead-name')).not.toHaveText(lead);
  const next = await page.locator('.lead-name').innerText();

  // Settings: "next" moves to J, dialing shows a QR code, and a daily goal. No scripts or recording any more.
  await page.getByRole('button', { name: 'Settings' }).click();
  const nextRow = page.locator('table.shortcuts tr', { hasText: 'Next lead' });
  await nextRow.locator('.keycap').first().click();
  await expect(nextRow).toContainText('press a key');
  await page.keyboard.press('j');
  await expect(nextRow.locator('.keycap').first()).toHaveText('J');
  await page.getByText('Show a QR code').click();
  await expect(page.getByRole('heading', { name: 'Scripts' })).toHaveCount(0);
  // Counties: the search box narrows the list.
  const counties = page.locator('.card', { has: page.getByRole('heading', { name: 'Counties and their area codes' }) });
  const firstCounty = (await counties.locator('tbody tr td').first().innerText()).split(',')[0]!;
  await counties.getByLabel('Find a county').fill('zzzz');
  await expect(counties.getByText('No county matches "zzzz".')).toBeVisible();
  await counties.getByLabel('Find a county').fill(firstCounty.slice(0, 4));
  await expect(counties.locator('tbody tr').first()).toContainText(firstCounty);
  await counties.getByLabel('Find a county').fill('');
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
  await page.screenshot({ path: 'test-results/calling-refined.png', fullPage: true });

  // J is now "next": every other lead in this list has been worked, so it says so.
  await page.keyboard.press('j');
  await expect(page.getByText(/worked the whole list/)).toBeVisible();

  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByText('No callbacks set.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Appointments today/ })).toBeVisible();
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
  await page.getByRole('button', { name: 'Picked up, no appt', exact: true }).click();
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

  // Copy link gives a link to paste into the appointment; opening it later goes straight back to this lead.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy link' }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/lead/[0-9a-f-]{36}$`));
  await page.getByRole('button', { name: 'Back to list' }).click();
  await expect(page.locator('.lead-name')).toHaveText(current);
  // The lead shown before loads slowly: its late answer must not replace the linked lead.
  const linked = link.split('/lead/')[1]!;
  const slow = /\/api\/leads\/[0-9a-f-]{36}$/;
  await page.route(slow, async (route) => {
    if (!route.request().url().endsWith(linked)) await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.goto(link);
  await expect(page.locator('.lead-name')).toHaveText('Robert Ray');
  await expect(page).toHaveURL(/#calling$/);
  await expect(page.locator('.lookup-bar')).toContainText('Your list on the left is unchanged');
  await page.waitForTimeout(1000);
  await expect(page.locator('.lead-name')).toHaveText('Robert Ray');
  await page.unroute(slow);

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
  await page.getByRole('button', { name: 'Today', exact: true }).click();
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
  const weekly = page.locator('.card', { has: page.getByRole('heading', { name: /Week by week/ }) });
  await expect(weekly.getByRole('columnheader', { name: 'This week' })).toBeVisible();
  await expect(weekly.getByRole('row', { name: /Show rate/ })).toContainText('80%');
  await weekly.screenshot({ path: 'test-results/weekly.png' });
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

test('save the call list, save as, load it back, and replace it from Leads', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  const queue = page.getByLabel('Queue');
  await expect(queue.locator('.queue-list li').first()).toBeVisible();
  const n = await queue.locator('.queue-list li').count();
  expect(n).toBeGreaterThan(0);

  // Save on a list that was never saved asks for a name, then saves without touching the list.
  await expect(queue.getByText('Unsaved list')).toBeVisible();
  await queue.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByLabel('Saved list name').fill('Old area');
  await page.getByRole('dialog', { name: 'Save call list as' }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved as "Old area"')).toBeVisible();
  await expect(queue.getByText('List: Old area')).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  await expect(queue.locator('.queue-list li')).toHaveCount(n);

  // Save as the same name offers to replace it rather than making a second one.
  await queue.getByRole('button', { name: 'Save as…' }).click();
  await expect(page.getByLabel('Saved list name')).toHaveValue('Old area');
  await expect(page.getByRole('button', { name: 'Replace "Old area"' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Clearing a saved, unchanged list doesn't ask to save it again.
  await queue.getByRole('button', { name: 'Clear list' }).click();
  await expect(page.getByRole('alertdialog').getByText('saved as Old area')).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear list' }).click();
  await expect(page.getByText('Your call list is empty.')).toBeVisible();

  // Load it back: same leads, and it carries its name.
  await queue.getByRole('button', { name: 'Load… (1)' }).click();
  await expect(page.getByText(`of ${n} left to call`)).toBeVisible();
  await page.getByRole('button', { name: 'Load Old area' }).click();
  await expect(queue.locator('.queue-list li')).toHaveCount(n);
  await expect(queue.getByText('List: Old area')).toBeVisible();
  await page.screenshot({ path: 'test-results/save-load.png' });

  // Replace it from Leads with every lead talked to before (no appointment). It's saved, so nothing to keep.
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'Picked up, no appt', exact: true }).click();
  await page.getByLabel(/Replace the call list/).check();
  await page.getByRole('button', { name: /^Replace with all \d+ matching$/ }).click();
  await expect(page.getByRole('alertdialog').getByText('saved as Old area')).toBeVisible();
  await page.screenshot({ path: 'test-results/replace-list.png' });
  await page.getByRole('button', { name: 'Replace call list' }).click();
  await expect(page.getByText(/^Call list replaced/)).toBeVisible();

  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await queue.getByRole('button', { name: 'Load… (1)' }).click();
  await expect(page.getByRole('dialog', { name: 'Load a call list' }).getByText('Old area')).toBeVisible();
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
  // D, then 2 and Enter: Dial: Picked up with the tick. The lead goes to the dead pile.
  await page.keyboard.press('d');
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('Dial: Picked up, do not call');
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
  // The time typed on Appt set shows until Unitrust sends its own.
  await expect(page.getByLabel('Current lead').locator('.appt-when')).toContainText('Tomorrow');
  await expect(page.getByLabel('Current lead').locator('.appt-when')).toContainText('not in Unitrust yet');
  const outcomes = page.getByRole('group', { name: 'Appointment outcome' });
  await expect(outcomes.getByRole('button')).toHaveText([/Appt: No show/, /Appt: Picked up/, /Appt: Presentation/, /Appt: Sale/, /Appt: Rescheduled/]);
  // M flips the side, and back.
  await page.keyboard.press('m');
  await expect(tabs.getByRole('tab', { name: 'First call' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('group', { name: 'Outcome', exact: true })).toContainText('No answer');
  await page.keyboard.press('m');
  await expect(outcomes).toBeVisible();
  await page.screenshot({ path: 'test-results/appointment-side.png', fullPage: true });
  // 3, Enter: Appt: Presentation. She comes back to be called, tagged as a prezi, on the First call side.
  await page.keyboard.press('3');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('Appt: Presentation');
  await lookUp('Ann Lee');
  await expect(page.getByLabel('Current lead').locator('.badge.appt-prezi')).toHaveText('Presentation, no sale');
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

test('best time first: the list can be shown and worked in that order, and it stays chosen', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  const order = page.getByRole('group', { name: 'Order' });
  const queue = page.getByLabel('Queue');
  await expect(queue.locator('.queue-list li').first()).toBeVisible();
  const n = await queue.locator('.queue-list li').count();
  await order.getByRole('button', { name: 'Best time first' }).click();
  await expect(order.getByRole('button', { name: 'Best time first' })).toHaveAttribute('aria-pressed', 'true');
  await expect(queue.locator('.queue-list li')).toHaveCount(n);
  await page.screenshot({ path: 'test-results/best-time-first.png' });
  await page.reload();
  await expect(page.getByRole('group', { name: 'Order' }).getByRole('button', { name: 'Best time first' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Order' }).getByRole('button', { name: 'As set' }).click();
});

test('an appointment about to start: an alert, and its prep card on Today', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  // Book Zed for ten minutes from now (in the browser's time), as Appt set with a time does; a minute ago near midnight.
  await page.evaluate(async () => {
    const leads = await (await fetch('/api/leads?search=Zed')).json();
    const now = new Date();
    let at = new Date(now.getTime() + 10 * 60_000);
    if (at.getDate() !== now.getDate()) at = new Date(now.getTime() - 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const wall = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const r = await fetch(`/api/leads/${leads.rows[0].id}/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: `e2e-${Date.now()}`, outcome_code: 'appointment', appointment_for: wall }),
    });
    if (!r.ok) throw new Error(await r.text());
  });
  await page.reload();
  await expect(page.locator('.alert-bar')).toContainText('Appointment:');
  await expect(page.locator('.alert-bar')).toContainText('Zed');
  const card = page.locator('.prep-card', { hasText: 'Zed' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('not in Unitrust yet');
  await page.screenshot({ path: 'test-results/today-appointments.png', fullPage: true });
});

test('on the spot: Run it now saves the Appt set and stays on the lead, on the Appointment side', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(page.locator('.phone-big')).toBeVisible();
  const lead = await page.locator('.lead-name').innerText();
  const tabs = page.getByRole('tablist', { name: 'Kind of call' });
  await expect(tabs.getByRole('tab', { name: 'First call' })).toHaveAttribute('aria-selected', 'true');
  // 3 picks Appt set; Shift+Enter runs it now.
  await page.keyboard.press('3');
  await expect(page.getByRole('button', { name: /Run it now/ })).toBeVisible();
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.undo-bar')).toContainText('Appt set, running it now');
  await expect(page.locator('.lead-name')).toHaveText(lead);
  await expect(tabs.getByRole('tab', { name: 'Appointment' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.timer')).toBeVisible();
  await page.screenshot({ path: 'test-results/on-the-spot.png', fullPage: true });
  // When it's done: 4, Enter logs the sale and moves on.
  await page.keyboard.press('4');
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText(`Saved for ${lead}: Appt: Sale`);
  await expect(page.getByLabel('Current lead').locator('.badge.appt-sold')).toBeVisible();
});

test('Settings → Buttons: rename a button, hide one, show Callback, then reset', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Settings' }).click();
  const card = page.locator('#outcomes');
  await card.getByLabel('Name for Dial: Bad number').fill('Dial: Wrong #');
  await card.getByLabel('Show a button for Dial: Picked up').uncheck();
  await card.getByLabel('Show a button for Callback').check();
  await card.getByRole('button', { name: 'Save buttons' }).click();
  await expect(page.getByText('Buttons saved')).toBeVisible();
  await page.screenshot({ path: 'test-results/outcomes-settings.png', fullPage: true });

  // The buttons the Calling screen gets (the lead showing now is in the dead pile, so it has none to click).
  const buttons = async () => {
    const meta = await (await page.request.get(new URL('/api/meta', page.url()).href)).json();
    return meta.outcome_codes.filter((o: any) => o.kind === 'first_call' && o.offered).map((o: any) => o.label);
  };
  expect(await buttons()).toEqual(['Dial: No answer', 'Dial: Appt set', 'Dial: Wrong #', 'Callback']);

  // Reset shows only on the three changed rows, and goes away once a row is back to its default.
  const resets = card.getByRole('button', { name: 'Reset' });
  await expect(resets).toHaveCount(3);
  for (let i = 0; i < 3; i++) await resets.first().click();
  await expect(resets).toHaveCount(0);
  await card.getByRole('button', { name: 'Save buttons' }).click();
  await expect(page.getByText('Buttons saved')).toHaveCount(1);
  await expect(card.getByLabel('Name for Dial: Bad number')).toHaveValue('Dial: Bad number');
  expect(await buttons()).toEqual(['Dial: No answer', 'Dial: Picked up', 'Dial: Appt set', 'Dial: Bad number']);
});

test('a button of your own: counts as No answer, red and dotted, adds a tag, and shows only while the lead lacks it', async ({ page }) => {
  await page.goto(launchUrl);
  const origin = new URL(page.url()).origin;
  await page.request.post(`${origin}/api/tags`, { data: { name: 'Voicemail' }, headers: { origin } });
  await page.getByRole('button', { name: 'Settings' }).click();
  const card = page.locator('#outcomes');
  await card.getByRole('button', { name: '+ Add a button' }).first().click();
  await card.getByLabel('Name for New button').fill('Left voicemail');
  await expect(card.getByLabel('Left voicemail: counts as')).toHaveValue('no_answer');
  await card.getByLabel('Left voicemail: color').selectOption('red');
  await card.getByLabel('Left voicemail: border').selectOption('dotted');
  await card.getByLabel('Left voicemail: adds').selectOption({ label: 'Voicemail' });
  await card.getByRole('button', { name: 'Only when…' }).click();
  const ed = card.getByRole('group', { name: 'Condition' });
  await ed.getByRole('tab', { name: 'Python' }).click();
  await ed.getByLabel('Condition in Python').fill('not has("Voicemail")');
  await ed.getByRole('button', { name: 'Use this condition' }).click();
  await expect(card.getByLabel('Left voicemail: show when')).toHaveText('not has("Voicemail")');
  await card.screenshot({ path: 'test-results/buttons-settings.png' });
  await card.getByRole('button', { name: 'Save buttons' }).click();
  await expect(page.getByText('Buttons saved')).toBeVisible();

  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(page.locator('.lead-panel')).toBeVisible();
  const lookUp = async (who: string) => {
    await page.keyboard.press('l');
    await page.keyboard.type(who);
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lead-name')).toHaveText(who);
  };
  await lookUp('Ann Lee');
  const outcomes = page.getByRole('group', { name: 'Outcome', exact: true });
  const mine = outcomes.getByRole('button', { name: 'Left voicemail' });
  await expect(mine).toHaveClass(/c-red/);
  await expect(mine).toHaveClass(/b-dotted/);
  await page.screenshot({ path: 'test-results/buttons-calling.png', fullPage: true });
  // It counts as No answer, which saves straight away.
  await mine.click();
  await expect(page.locator('.undo-bar')).toContainText('Saved for Ann Lee: Left voicemail');
  // She has the tag now, so the button is gone for her.
  await lookUp('Ann Lee');
  await expect(outcomes.getByRole('button', { name: 'Dial: No answer' })).toBeVisible();
  await expect(outcomes.getByRole('button', { name: 'Left voicemail' })).toHaveCount(0);
});

test('a button as Python: read it, change it there, and see the change in the form', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Settings' }).click();
  const card = page.locator('#outcomes');
  await card.getByRole('row').filter({ has: page.getByLabel('Name for Left voicemail') }).getByRole('button', { name: 'More' }).click();
  await card.getByRole('tab', { name: 'Python' }).click();
  const py = card.getByLabel('Button in Python');
  await expect(py).toHaveValue([
    `@button(counts_as="Dial: No answer", shows_when='not has("Voicemail")', color="red", border="dotted")`,
    'def button():',
    '    "Left voicemail"',
    '    add_tag("Voicemail")',
  ].join('\n'));
  // A mistake says where, and holds the form and Save until it's fixed.
  await py.fill('@button(counts_as="Dial: No answer")\ndef button():\n    "Left voicemail"\n    add_tag("Nope")');
  await expect(card.getByLabel('Python mistake')).toHaveText('Line 4: there is no tag called "Nope": make it under Tags first');
  await expect(card.getByRole('button', { name: 'Save buttons' })).toBeDisabled();
  await py.fill('@button(counts_as="Dial: No answer", color="purple", fill="filled", tooltip="Left a message")\ndef button():\n    "Left voicemail"\n    add_tag("Voicemail")');
  await expect(card.getByLabel('Python mistake')).toHaveCount(0);
  await card.screenshot({ path: 'test-results/button-python.png' });
  await card.getByRole('tab', { name: 'Form' }).click();
  await expect(card.getByLabel('Left voicemail: color')).toHaveValue('purple');
  await expect(card.getByLabel('Left voicemail: tooltip')).toHaveValue('Left a message');
  await card.getByRole('button', { name: 'Save buttons' }).click();
  await expect(page.getByText('Buttons saved')).toBeVisible();
  const meta = await (await page.request.get(new URL('/api/meta', page.url()).href)).json();
  expect(meta.buttons.find((b: any) => b.label === 'Left voicemail')).toMatchObject({ color: 'purple', fill: 'filled', border: 'solid', show_when: '' });
});

test('a field that shows by condition, needed while another is true, filled in by a button that asks for it', async ({ page }) => {
  await page.goto(launchUrl);
  const origin = new URL(page.url()).origin;
  await page.request.post(`${origin}/api/custom-fields`, { data: { label: 'Best time', type: 'text' }, headers: { origin } });
  await page.getByRole('button', { name: 'Settings' }).click();
  const fields = page.locator('#custom-fields');
  const when = async (button: string, python: string) => {
    await fields.getByRole('button', { name: button }).click();
    const ed = fields.getByRole('group', { name: 'Condition' });
    await ed.getByRole('tab', { name: 'Python' }).click();
    await ed.getByLabel('Condition in Python').fill(python);
    await ed.getByRole('button', { name: 'Use this condition' }).click();
  };
  await when('Only when…', 'has("Voicemail")');
  await when('Needed when…', 'attempts >= 1');
  await expect(fields.getByLabel('Best time: shows when')).toHaveText('has("Voicemail")');
  await fields.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Field saved')).toBeVisible();

  const card = page.locator('#outcomes');
  await card.getByRole('row').filter({ has: page.getByLabel('Name for Left voicemail') }).getByRole('button', { name: 'More' }).click();
  await card.getByLabel('Left voicemail: asks for').selectOption({ label: 'Best time' });
  await card.getByRole('button', { name: 'Save buttons' }).click();
  await expect(page.getByText('Buttons saved')).toBeVisible();

  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await expect(page.locator('.lead-panel')).toBeVisible();
  const lookUp = async (who: string) => {
    await page.keyboard.press('l');
    await page.keyboard.type(who);
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lead-name')).toHaveText(who);
  };
  // Ann Lee has the Voicemail tag and has been called: the field shows, and it's needed.
  await lookUp('Ann Lee');
  const lead = page.getByLabel('Current lead');
  await expect(lead.getByText('Best time')).toBeVisible();
  await expect(lead.getByText('needed')).toBeVisible();
  await page.getByRole('group', { name: 'Outcome', exact: true }).getByRole('button', { name: 'Left voicemail' }).click();
  const asked = page.getByRole('group', { name: 'Fields this button asks for' });
  await expect(asked.getByLabel('Best time')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toContainText('Best time is needed for this lead');
  await asked.getByLabel('Best time').fill('evenings');
  await page.screenshot({ path: 'test-results/button-asks.png', fullPage: true });
  await page.keyboard.press('Enter');
  await expect(page.locator('.undo-bar')).toContainText('Saved for Ann Lee: Left voicemail');
  await lookUp('Ann Lee');
  await expect(lead.getByText('evenings')).toBeVisible();
});

test('Reports: arrange the cards, show By hour as a table, save a layout and load it back', async ({ page }) => {
  // The first layout save answers slowly, as on a busy computer: the later changes must still win.
  let slowed = false;
  await page.route('**/api/reports/layouts', async (route) => {
    if (route.request().method() === 'PUT' && !slowed) {
      slowed = true;
      await new Promise((r) => setTimeout(r, 400));
    }
    await route.continue();
  });
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Reports' }).click();
  const order = () => page.locator('main section[aria-label], section[aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  await expect(page.getByRole('heading', { name: /^Activity/ })).toBeVisible();
  const before = await order();
  expect(before.slice(0, 3)).toEqual(['Activity', 'Local vs out-of-area caller ID', 'By lead type']);
  expect(before).not.toContain('By lead age');

  await page.getByRole('button', { name: 'Arrange cards' }).click();
  await page.getByLabel('Show Activity').uncheck();
  await page.getByLabel('Show By lead age').check();
  await page.getByRole('button', { name: 'Move By lead type up' }).click();
  await page.getByRole('group', { name: 'By hour as' }).getByRole('button', { name: 'Table' }).click();
  await page.getByLabel('Layout name').fill('Friday');
  await page.getByRole('button', { name: 'Save as preset' }).click();
  await expect(page.getByText('Saved layout "Friday"')).toBeVisible();
  await page.screenshot({ path: 'test-results/reports-arrange.png', fullPage: true });
  await page.getByRole('button', { name: 'Done arranging' }).click();

  await expect(page.getByRole('heading', { name: /^Activity/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^By lead age/ })).toBeVisible();
  expect((await order()).slice(0, 2)).toEqual(['By lead type', 'Local vs out-of-area caller ID']);
  await expect(page.locator('section[aria-label="By hour"] table')).toBeVisible();

  // Back to default, then load Friday again; it all survives a reload.
  await page.getByRole('button', { name: 'Arrange cards' }).click();
  await page.getByRole('button', { name: 'Back to default' }).click();
  await page.getByRole('button', { name: 'Done arranging' }).click();
  await expect(page.getByRole('heading', { name: /^Activity/ })).toBeVisible();
  await page.getByLabel('Load a saved layout').selectOption('Friday');
  await expect(page.getByRole('heading', { name: /^Activity/ })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: /^By lead age/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Activity/ })).toHaveCount(0);

  // Leave Reports as it was for anything after this.
  await page.getByRole('button', { name: 'Arrange cards' }).click();
  await page.getByRole('button', { name: 'Back to default' }).click();
});

test('never dial: a tag marked in Settings keeps a lead off the list, with Add anyway, a red banner and a question before dialing', async ({ page }) => {
  await page.goto(launchUrl);
  const origin = new URL(page.url()).origin;
  // A callable lead, off the list, tagged DNC.
  const rows = (await (await page.request.get(`${origin}/api/leads?status=no_answer&not_on_list=1`)).json()).rows as { id: string; first_name: string; last_name: string }[];
  const who = { lead_id: rows[0]!.id, name: `${rows[0]!.first_name} ${rows[0]!.last_name}` };
  await page.request.post(`${origin}/api/leads/${who.lead_id}/tags`, { data: { name: 'DNC' }, headers: { origin } });

  await page.getByRole('button', { name: 'Settings' }).click();
  const mark = page.locator('#tags').getByLabel('DNC: never dial');
  await mark.click();
  await expect(mark).toBeChecked();
  await expect(page.getByText('Leads tagged DNC are never dialed')).toBeVisible();

  // From Leads: she's skipped, and the toast says so and offers her.
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByLabel('Tag', { exact: true }).selectOption({ label: 'Tagged DNC' });
  await expect(page.locator('table.grid tbody tr')).toHaveCount(1);
  await page.getByLabel('Tick every lead shown').check();
  await page.getByRole('button', { name: 'Add 1 ticked to call list' }).click();
  await expect(page.locator('.toast')).toContainText('0 leads added to the call list; 1 skipped');
  await page.locator('.toast').getByRole('button', { name: 'See skipped' }).click();
  const dlg = page.getByRole('dialog', { name: 'Skipped: never dial' });
  await expect(dlg).toContainText('tagged DNC');
  await page.screenshot({ path: 'test-results/never-dial-skipped.png' });
  await dlg.getByRole('button', { name: `Add ${who.name} anyway` }).click();
  await expect(page.getByText(`${who.name} added to the call list anyway`)).toBeVisible();
  await expect(dlg).toHaveCount(0);

  // On the Calling screen: a red banner, and dialing asks first.
  await page.getByRole('button', { name: 'Calling', exact: true }).click();
  await page.getByLabel('Queue').locator('.queue-list li', { hasText: who.name }).click();
  await expect(page.locator('.lead-name')).toHaveText(who.name);
  await expect(page.getByRole('alert').filter({ hasText: 'Do not call' })).toContainText('Do not call: tagged DNC');
  await page.screenshot({ path: 'test-results/never-dial-banner.png', fullPage: true });
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
  await page.locator('.lead-panel').getByRole('button', { name: /^(Copy number|Show QR|Dial on phone)/ }).first().click();
  await expect.poll(() => asked).toBe(`${who.name} is tagged DNC, which is never dialed. Dial anyway?`);
});

test('who can be called: a condition in Settings → Calling decides which leads can be ticked on Leads', async ({ page }) => {
  await page.goto(launchUrl);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByLabel('Can be called when')).toHaveText('status != "appointment_set"');
  await page.getByLabel('Can be called when').locator('..').getByRole('button', { name: 'Edit', exact: true }).click();
  const ed = page.getByRole('group', { name: 'Condition' });
  await ed.getByRole('tab', { name: 'Python' }).click();
  await ed.getByLabel('Condition in Python').fill('has("DNC")');
  await ed.getByRole('button', { name: 'Use this condition' }).click();
  await expect(page.getByLabel('Can be called when')).toHaveText('has("DNC")');
  await page.screenshot({ path: 'test-results/who-can-be-called.png' });

  // Only the DNC-tagged lead can be ticked now (it's still never dialed without Add anyway).
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByLabel('Not on the call list').uncheck();
  const ticks = page.locator('table.grid tbody input[type=checkbox]');
  await expect(ticks.first()).toBeVisible();
  const enabled = await ticks.evaluateAll((els) => els.filter((e) => !(e as HTMLInputElement).disabled).length);
  expect(enabled).toBeLessThanOrEqual(1);

  // Back to the start.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Back to the start' }).click();
  await expect(page.getByLabel('Can be called when')).toHaveText('status != "appointment_set"');
});
