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
