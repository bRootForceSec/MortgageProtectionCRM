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

test.afterAll(async () => {
  // Once the server has stopped, its data folder goes, so runs don't fill the disk.
  if (server && server.exitCode === null) {
    await new Promise((r) => { server.once('exit', r); server.kill('SIGTERM'); setTimeout(r, 5000); });
  }
  // Best-effort: Windows won't delete a file a server that didn't stop in time still has open.
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

test('work the day by routine: imports, then a step saved from Leads', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();

  // Import without putting the leads on the list: the routine's imports step does that.
  await page.locator('.topbar nav').getByRole('button', { name: 'Import', exact: true }).click();
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

test('tags: tag a lead, tag all matching, filter by tag, a routine step by tag, and Settings', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();

  // On a lead: + Tag, type a new name.
  await nav('Leads');
  await page.locator('table.grid tbody tr').first().click();
  const viewer = page.getByRole('dialog', { name: 'Lead' });
  const tags = viewer.getByLabel('Tags');
  await tags.getByRole('button', { name: '+ Tag' }).click();
  await tags.getByLabel('Tag name').fill('Spanish');
  await tags.getByLabel('Tag name').press('Enter');
  await expect(tags.locator('.tag-chip')).toHaveText(['Spanish×']);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);

  // Filter by it: one lead, showing its tag.
  await page.getByLabel('Tag', { exact: true }).selectOption({ label: 'Tagged Spanish' });
  await expect(page.getByText('1 lead', { exact: true })).toBeVisible();
  await expect(page.locator('table.grid tbody .tag-chip')).toHaveText(['Spanish']);

  // Tag every lead with no tags "Friday".
  await page.getByLabel('Tag', { exact: true }).selectOption({ label: 'No tags' });
  await expect(page.getByText('3 leads', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tag all matching' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tag all matching' });
  await dialog.getByLabel('Tag name').fill('Friday');
  await dialog.getByRole('button', { name: 'Tag 3 leads' }).click();
  await expect(page.getByText('Tagged 3 leads "Friday"')).toBeVisible();
  await expect(page.getByText('No leads here.')).toBeVisible();

  // A routine step that filters by the tag says its name.
  await page.getByLabel('Tag', { exact: true }).selectOption({ label: 'Tagged Friday' });
  await expect(page.getByText('3 leads', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save as routine step' }).click();
  const save = page.getByRole('dialog', { name: 'Save as routine step' });
  await expect(save).toContainText('Tagged "Friday"');
  await save.getByRole('button', { name: 'Cancel' }).click();

  // Settings: both tags with their counts; rename one.
  await nav('Settings');
  const card = page.locator('#tags');
  await expect(card.locator('tbody tr')).toHaveCount(2);
  await card.getByLabel('Name of tag Friday').fill('Friday list');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByLabel('Name of tag Friday list')).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/tags-settings.png' });
});

test('your fields: define them in Settings, fill one in on a lead, filter Leads on it', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();

  await nav('Settings');
  const card = page.locator('#custom-fields');
  await card.getByLabel('New field name').fill('Mortgage payment');
  await card.getByLabel('New field kind').selectOption('money');
  await card.getByRole('button', { name: 'Add field' }).click();
  await expect(card.getByLabel('New field name')).toHaveValue('');
  await card.getByLabel('New field name').fill('Who decides');
  await card.getByLabel('New field kind').selectOption('choice');
  await card.getByLabel('New field choices').fill('Husband, Wife, Both');
  await card.getByRole('button', { name: 'Add field' }).click();
  await expect(card.locator('tbody tr')).toHaveCount(3);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/custom-fields-settings.png' });

  // Fill them in on a lead with Edit; a wrong value says what's wrong.
  await nav('Leads');
  await page.locator('table.grid tbody tr').first().click();
  const viewer = page.getByRole('dialog', { name: 'Lead' });
  await viewer.getByRole('button', { name: /^Edit/ }).first().click();
  const edit = page.getByRole('dialog', { name: 'Edit lead' });
  await edit.getByLabel('Mortgage payment').fill('lots');
  await edit.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByText('Mortgage payment: needs a number')).toBeVisible();
  await edit.getByLabel('Mortgage payment').fill('1,850');
  await edit.getByLabel('Who decides').selectOption('Wife');
  await edit.getByRole('button', { name: /^Save/ }).click();
  await expect(edit).toHaveCount(0);
  await expect(viewer.locator('.facts')).toContainText('Mortgage payment$1,850.00');
  await expect(viewer.locator('.facts')).toContainText('Who decidesWife');
  await page.keyboard.press('Escape');

  await page.getByLabel('Your field').selectOption({ label: 'Who decides' });
  await expect(page.getByText('1 lead', { exact: true })).toBeVisible();
  await page.getByLabel('Who decides is').selectOption('Husband');
  await expect(page.getByText('No leads here.')).toBeVisible();
  await page.getByLabel('Who decides is').selectOption('Wife');
  await expect(page.getByText('1 lead', { exact: true })).toBeVisible();
});

test('rules: a ready-made one, one made from the Leads filters, preview, run now and the log', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();

  // From Leads: the leads tagged Spanish get tagged Hot, when you press Run now.
  await nav('Leads');
  await page.getByLabel('Tag', { exact: true }).selectOption({ label: 'Tagged Spanish' });
  await expect(page.getByText('1 lead', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Make a rule' }).click();
  const editor = page.getByRole('dialog', { name: 'New rule' });
  await expect(editor).toContainText('Tagged "Spanish"');
  await editor.getByLabel('Rule name').fill('Spanish are hot');
  await editor.getByLabel('When', { exact: true }).selectOption('manual');
  await editor.getByLabel('Action 1', { exact: true }).selectOption('add_tag');
  await editor.getByLabel('Action 1 tag').fill('Hot');
  await editor.getByRole('button', { name: 'Preview' }).click();
  await expect(editor.getByLabel('Preview')).toContainText('Would match 1 lead');
  await expect(editor.getByLabel('Preview')).toContainText('Tag "Hot": 1 lead');
  await editor.getByRole('button', { name: 'Save rule' }).click();
  await expect(editor).toHaveCount(0);

  // Settings: add the ready-made no-show rule, switched off.
  await nav('Settings');
  const card = page.locator('#rules');
  await card.getByLabel('Add a ready-made rule').selectOption({ label: "Yesterday's no-shows onto the call list" });
  const starter = page.getByRole('dialog', { name: 'New rule' });
  await expect(starter.getByLabel('Rule name')).toHaveValue("Yesterday's no-shows onto the call list");
  await starter.getByRole('button', { name: 'Save rule' }).click();
  await expect(card.getByLabel("Rule Yesterday's no-shows onto the call list")).toContainText('At 08:00 every day');
  await expect(card.getByLabel("Rule Yesterday's no-shows onto the call list")).toContainText('No-shows · Appointment yesterday');

  // Run the Leads one now: the log has it.
  const mine = card.getByLabel('Rule Spanish are hot');
  await expect(mine).toContainText('Only when you press Run now');
  await mine.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText('"Spanish are hot" ran on 1 lead')).toBeVisible();
  await card.getByText(/^Log: what rules did/).click();
  await expect(card.getByLabel('Rules log')).toContainText('Spanish are hot');
  await expect(card.getByLabel('Rules log')).toContainText('Tag "Hot": 1 lead');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/rules-settings.png' });
});

test('a formula field: write it with a preview, see it on the lead, sort and filter Leads by it', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();

  await nav('Settings');
  const card = page.locator('#custom-fields');
  await card.getByLabel('New field name').fill('Score');
  await card.getByLabel('New field kind').selectOption('formula');
  const formula = card.getByLabel('New field formula');
  await formula.fill('[Mortgage payment] / 10 +');
  await expect(card.getByRole('status', { name: 'Check of New field' })).toContainText('the formula stops too soon');
  await formula.fill('[Mortgage payment] / 10');
  await expect(card.getByRole('status', { name: 'Check of New field' })).toContainText(/Works out to a number for 1 of \d+ leads · from 185 to 185/);
  await card.getByText('What you can use').click();
  await card.getByRole('button', { name: 'attempts', exact: true }).click();
  await expect(formula).toHaveValue('[Mortgage payment] / 10attempts');
  await formula.fill('ifblank([Mortgage payment], 0) / 10');
  await card.getByRole('button', { name: 'Add field' }).click();
  await expect(card.getByLabel('Field Score formula')).toHaveValue('ifblank([Mortgage payment], 0) / 10');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/formula-field-settings.png' });

  // Leads: highest score first, with the score shown; then only scores of 100 or more.
  await nav('Leads');
  await page.getByLabel('Order').selectOption({ label: 'Highest Score first' });
  await expect(page.locator('table.grid thead')).toContainText('Score');
  const first = page.locator('table.grid tbody tr').first();
  await expect(first.locator('td').nth(2)).toHaveText('185');
  await page.getByLabel('Your field').selectOption({ label: 'Score' });
  await page.getByLabel('Score at least').fill('100');
  await expect(page.getByText('1 lead', { exact: true })).toBeVisible();

  // On the lead it's a fact, not something to type in.
  await first.click();
  const viewer = page.getByRole('dialog', { name: 'Lead' });
  await expect(viewer.locator('.facts')).toContainText('Score185');
  await viewer.getByRole('button', { name: /^Edit/ }).first().click();
  const edit = page.getByRole('dialog', { name: 'Edit lead' });
  await expect(edit.getByLabel('Mortgage payment')).toBeVisible();
  await expect(edit.getByLabel('Score')).toHaveCount(0);
});

test('Google Calendar in Settings: the steps, saving your key, then Connect', async ({ page }) => {
  await page.goto(launchUrl);
  await page.locator('.topbar nav').getByRole('button', { name: 'Settings', exact: true }).click();
  const card = page.locator('#google-calendar');
  await expect(card.getByText('Step 1: make your Google key')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Connect Google' })).toBeDisabled();
  await card.getByLabel('Google Client ID').fill('not a key');
  await card.getByLabel('Google Client secret').fill('GOCSPX-0123456789');
  await card.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('that Client ID should end in .apps.googleusercontent.com')).toBeVisible();
  await card.getByLabel('Google Client ID').fill('1234-abc.apps.googleusercontent.com');
  await card.getByRole('button', { name: 'Save key' }).click();
  await expect(card.getByText('Key saved.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Connect Google' })).toBeEnabled();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/google-calendar-settings.png' });
});

test('Settings in sections with a menu; Leads shows which leads and how many on a page', async ({ page }) => {
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();
  await nav('Settings');
  const menu = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(menu.getByRole('button')).toHaveText(['Calling', 'Your day', 'Leads', 'Unitrust and Google', 'Imports', 'App']);
  // The cards above load on their own and can grow after the jump on a slow computer, so jump again until it's there.
  await expect(async () => {
    await menu.getByRole('button', { name: 'Unitrust and Google settings' }).click();
    await expect(page.getByRole('region', { name: 'Unitrust and Google' }).locator('#google-calendar')).toBeInViewport({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Leads' }).locator('#custom-fields')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/settings-sections.png' });

  await nav('Leads');
  const shown = page.getByLabel('Leads shown').first();
  await expect(shown).toHaveText(/^1–\d+ of \d+$/);
  await page.getByLabel('Leads per page').first().selectOption('25');
  await expect(page.getByLabel('Leads per page').first()).toHaveValue('25');
});

test('a condition on Leads: built in the form, read as Python, and back', async ({ page }) => {
  await page.goto(launchUrl);
  await page.locator('.topbar nav').getByRole('button', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'Condition…' }).click();
  const ed = page.getByRole('group', { name: 'Condition' });
  // Form: has tag Spanish (tagged earlier in these tests).
  await ed.getByRole('button', { name: '+ Row' }).click();
  await ed.getByLabel('Tag', { exact: true }).fill('Spanish');
  await expect(ed.getByLabel('Condition matches')).toHaveText(/^Matches 1 of \d+ leads$/);
  // The same condition as Python; add to it there.
  await ed.getByRole('tab', { name: 'Python' }).click();
  const py = ed.getByLabel('Condition in Python');
  await expect(py).toHaveValue('has("Spanish")');
  await py.fill('has("Spanish") or times("Spanish", days=7) >= 1 or attempts >= 0');
  await expect(ed.getByLabel('Condition matches')).toHaveText(/^Matches 4 of \d+ leads$/);
  await py.fill('has("Spanish") or');
  await expect(ed.getByLabel('Condition matches')).toHaveText(/stops too soon/);
  await expect(ed.getByRole('button', { name: 'Use this condition' })).toBeDisabled();
  await py.fill('has("Spanish") or times("Spanish", days=7) >= 1 or attempts >= 0');
  // Back to the form: an "Any of these" group with its three rows.
  await ed.getByRole('tab', { name: 'Form' }).click();
  await expect(ed.getByLabel('Match', { exact: true })).toHaveValue('any');
  await expect(ed.getByLabel('Row kind')).toHaveCount(3);
  await expect(ed.getByLabel('Condition matches')).toHaveText(/^Matches 4 of/);
  await page.screenshot({ path: 'test-results/condition-editor.png' });
  await ed.getByRole('button', { name: 'Use this condition' }).click();
  await expect(page.getByLabel('Condition in use')).toHaveText('has("Spanish") or times("Spanish", days=7) >= 1 or attempts >= 0');
  await expect(page.getByText('4 leads', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove the condition' }).click();
  await expect(page.getByLabel('Condition in use')).toHaveCount(0);
});

test('a status: named in Settings from a condition, shown as a badge and a Leads tab', async ({ page }) => {
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();
  await nav('Settings');
  const card = page.locator('#statuses');
  await card.getByRole('button', { name: '+ Status' }).click();
  await card.getByLabel('New status name').fill('Speaks Spanish');
  const ed = card.getByRole('group', { name: 'Condition' });
  await ed.getByRole('tab', { name: 'Python' }).click();
  await ed.getByLabel('Condition in Python').fill('has("Spanish")');
  await expect(ed.getByLabel('Condition matches')).toHaveText(/^Matches 1 of/);
  await ed.getByRole('button', { name: 'Use this condition' }).click();
  await expect(card.getByLabel('Name of status Speaks Spanish')).toBeVisible();
  await card.getByLabel('Speaks Spanish as a Leads tab').check();
  await expect(card.getByLabel('Speaks Spanish as a Leads tab')).toBeChecked();
  await card.screenshot({ path: 'test-results/statuses-card.png' });

  await nav('Leads');
  await page.getByRole('button', { name: 'Speaks Spanish', exact: true }).click();
  await expect(page.getByText('1 lead', { exact: true })).toBeVisible();
  await expect(page.locator('.status-chip', { hasText: 'Speaks Spanish' })).toHaveCount(1);
  await page.screenshot({ path: 'test-results/statuses-leads.png' });
});

test('a rule on a tag, with a counter: tagging a lead sets it off at once', async ({ page }) => {
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();
  await nav('Settings');
  // A counter field.
  const fields = page.locator('#custom-fields');
  await fields.getByLabel('New field name').fill('VIP count');
  await fields.getByLabel('New field kind').selectOption('counter');
  await fields.getByRole('button', { name: 'Add field' }).click();
  await expect(fields.getByLabel('New field name')).toHaveValue('');

  // When "VIP" is put on: tag "Call today", add 1 to VIP count.
  const card = page.locator('#rules');
  await card.getByRole('button', { name: '+ New rule' }).click();
  const editor = page.getByRole('dialog', { name: 'New rule' });
  await editor.getByLabel('Rule name').fill('VIPs today');
  await editor.getByLabel('When', { exact: true }).selectOption('tag_added');
  await editor.getByLabel('Trigger tag').fill('VIP');
  await editor.getByLabel('Action 1', { exact: true }).selectOption('add_tag');
  await editor.getByLabel('Action 1 tag').fill('Call today');
  await editor.getByRole('button', { name: '+ Another action' }).click();
  await editor.getByLabel('Action 2', { exact: true }).selectOption('counter');
  await expect(editor.getByLabel('Action 2 counter')).toHaveValue(/.+/);
  await editor.screenshot({ path: 'test-results/rule-on-tag.png' });
  await editor.getByRole('button', { name: 'Save rule' }).click();
  await expect(editor).toHaveCount(0);
  await expect(card.getByLabel('Rule VIPs today')).toContainText('When tag "VIP" is put on a lead');
  await expect(card.getByLabel('Rule VIPs today')).toContainText('Add 1 to VIP count');

  // Tag a lead VIP: the rule's tag shows straight away.
  await nav('Leads');
  await page.locator('table.grid tbody tr').first().click();
  const viewer = page.getByRole('dialog', { name: 'Lead' });
  const tags = viewer.getByLabel('Tags');
  await tags.getByRole('button', { name: '+ Tag' }).click();
  await tags.getByLabel('Tag name').fill('VIP');
  await tags.getByLabel('Tag name').press('Enter');
  await expect(tags.locator('.tag-chip', { hasText: 'Call today' })).toHaveCount(1);
  await expect(tags.locator('.tag-chip', { hasText: 'VIP' })).toHaveCount(1);
});

test('tag shortcuts: a tag that comes off at the end of the day, and only one of a group at a time, each shown as rules', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await page.goto(launchUrl);
  const nav = (name: string) => page.locator('.topbar nav').getByRole('button', { name, exact: true }).click();
  await nav('Settings');
  const card = page.locator('#tags');
  await card.getByLabel('When Call today comes off by itself').selectOption('day');
  await expect(card.getByLabel('When Call today comes off by itself')).toHaveValue('day');

  await card.getByRole('button', { name: '+ Group' }).click();
  const editor = card.getByRole('group', { name: 'Edit group' });
  await editor.getByLabel('Group name').fill('Temperature');
  await editor.getByLabel('Hot', { exact: true }).check();
  await editor.getByLabel('VIP', { exact: true }).check();
  await editor.getByRole('button', { name: 'Save group' }).click();
  const group = card.getByLabel('Group Temperature');
  await expect(group).toContainText('Putting on "Hot" takes off "VIP"');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/tag-shortcuts.png' });

  // Settings → Rules lists the rules they wrote, to preview and run but not edit.
  const rules = page.locator('#rules');
  const expiry = rules.getByLabel('Rule Take "Call today" off at the end of the day it was put on');
  await expect(expiry).toContainText('change it in Settings → Tags');
  await expect(expiry.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(rules.getByLabel('Rule Temperature: "Hot" takes the others off')).toContainText('Take tag "VIP" off');
});

test('a rule as Python: read it, change it there, and see the change in the form', async ({ page }) => {
  await page.goto(launchUrl);
  await page.locator('.topbar nav').getByRole('button', { name: 'Settings', exact: true }).click();
  const card = page.locator('#rules');
  await card.getByLabel('Rule VIPs today').getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit rule' });
  await editor.getByRole('tab', { name: 'Python' }).click();
  const py = editor.getByLabel('Rule in Python');
  await expect(py).toHaveValue(/^@when\(tag_added="VIP"\)\ndef rule\(\):\n {4}"VIPs today"\n {4}add_tag\("Call today"\)\n {4}counter\("VIP count", add=1\)$/);

  // A mistake says where, and holds the form and Save until it's fixed.
  await py.fill('@when(tag_added="VIP")\ndef rule():\n    "VIPs today"\n    add_tag(Call today)');
  await expect(editor.getByLabel('Python mistake')).toContainText('Line 4');
  await expect(editor.getByRole('button', { name: 'Save rule' })).toBeDisabled();

  await py.fill('@when(tag_added="VIP")\n@leads(last_call="today")\ndef rule():\n    "VIPs today"\n    if age >= 50:\n        add_tag("Call today")\n        counter("VIP count", add=2)\n        remove_tag("Spanish")');
  await expect(editor.getByLabel('Python mistake')).toHaveCount(0);
  await editor.screenshot({ path: 'test-results/rule-python.png' });
  await editor.getByRole('tab', { name: 'Form' }).click();
  await expect(editor.getByLabel('Action 3', { exact: true })).toHaveValue('remove_tag');
  await expect(editor.getByLabel('Action 2 number')).toHaveValue('2');
  await expect(editor.getByLabel('Last call')).toHaveValue('today');
  await editor.getByRole('button', { name: 'Save rule' }).click();
  await expect(card.getByLabel('Rule VIPs today')).toContainText('Add 2 to VIP count');
  await expect(card.getByLabel('Rule VIPs today')).toContainText('Where age >= 50');
});

test('a rule that makes a lead come back: steps in the form, read back in words and in Python', async ({ page }) => {
  await page.goto(launchUrl);
  await page.locator('.topbar nav').getByRole('button', { name: 'Settings', exact: true }).click();
  const card = page.locator('#rules');
  await card.getByRole('button', { name: '+ New rule' }).click();
  const editor = page.getByRole('dialog', { name: 'New rule' });
  await editor.getByLabel('Rule name').fill('Ghosted: come back');
  await editor.getByLabel('When', { exact: true }).selectOption('manual');
  await editor.getByLabel('Action 1', { exact: true }).selectOption('come_back');
  const steps = editor.getByLabel('Action 1 steps');
  await expect(steps).toHaveValue('1d@09:00');
  await steps.fill('15m, soon');
  await expect(editor.getByText('write each step like 15m, 2h, 3d or 1d@09:00')).toBeVisible();
  await steps.fill('15m, 1d@09:00, 3d');
  await expect(editor.getByText('write each step like 15m, 2h, 3d or 1d@09:00')).toHaveCount(0);
  await editor.getByRole('tab', { name: 'Python' }).click();
  await expect(editor.getByLabel('Rule in Python')).toHaveValue(/come_back\("15m", "1d@09:00", "3d"\)/);
  await editor.getByRole('tab', { name: 'Form' }).click();
  await editor.getByRole('button', { name: 'Save rule' }).click();
  await expect(card.getByLabel('Rule Ghosted: come back')).toContainText('Come back after 15m, then 1d@09:00, then 3d');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/rule-come-back.png' });
});
