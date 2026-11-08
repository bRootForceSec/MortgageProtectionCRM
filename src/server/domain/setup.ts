import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import { DomainError } from '../core/errors.js';
import { ButtonDef } from '../../shared/buttons.js';
import { CustomFieldInput } from '../../shared/customFields.js';
import { loadButtons, saveButtons } from './buttons.js';
import { loadCallingSettings, saveCallingSettings } from './callingSettings.js';
import { createCustomField, listCustomFields, updateCustomField } from './customFields.js';
import { loadStatusDefs } from './formulas.js';
import { loadFunnelSteps, saveFunnelSteps } from './funnel.js';
import { loadReportLayouts, saveReportLayouts } from './reportLayouts.js';
import { loadTargets, saveTargets } from './reports.js';
import { loadRules, loadTagShortcuts, saveRules, saveTagShortcuts } from './rules.js';
import { saveStatuses } from './statuses.js';
import { ensureTag, listTags, renameTag, setNeverDial } from './tags.js';

// Your setup as one file: tags, fields, smart lists, buttons, rules, tag shortcuts, funnel steps, calling settings and
// report layouts. No leads, calls or secrets. Loading one adds the tags and fields it names (nothing is deleted) and
// replaces the rest, each through its own save so the same checks apply; one mistake and nothing changes.

const KIND = 'mpcrm-setup';

const SetupFile = z.object({
  kind: z.literal(KIND, { error: "that isn't a setup file saved from this CRM" }),
  version: z.literal(1),
  saved_at: z.string().optional(),
  tags: z.array(z.object({ id: z.string(), name: z.string(), never_dial: z.boolean().default(false) })).max(5000),
  fields: z.array(CustomFieldInput.extend({ id: z.string() })).max(500),
  statuses: z.unknown(),
  buttons: z.unknown(),
  rules: z.unknown(),
  tag_shortcuts: z.unknown(),
  funnel_steps: z.unknown(),
  calling: z.unknown(),
  report_layouts: z.unknown(),
  report_targets: z.unknown(),
});

export function exportSetup(db: DB, now = new Date().toISOString()) {
  return {
    kind: KIND,
    version: 1 as const,
    saved_at: now,
    tags: listTags(db).map((t) => ({ id: t.id, name: t.name, never_dial: t.never_dial })),
    fields: listCustomFields(db).map((f) => ({
      id: f.id, label: f.label, type: f.type,
      ...(f.type === 'choice' ? { options: f.options } : {}),
      ...(f.formula ? { formula: f.formula } : {}),
      ...(f.show_when ? { show_when: f.show_when } : {}),
      ...(f.required_when ? { required_when: f.required_when } : {}),
    })),
    statuses: loadStatusDefs(db),
    // Without what the server adds (side, own, default key).
    buttons: loadButtons(db).map((b) => ButtonDef.parse(b)),
    rules: loadRules(db).filter((r) => !r.made_by),
    tag_shortcuts: loadTagShortcuts(db),
    funnel_steps: loadFunnelSteps(db),
    calling: loadCallingSettings(db),
    report_layouts: loadReportLayouts(db),
    report_targets: loadTargets(db),
  };
}

/** Swaps every string that is one of the file's tag or field ids for the id it has here. */
function remap(v: unknown, ids: Map<string, string>): unknown {
  if (typeof v === 'string') return ids.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => remap(x, ids));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [ids.get(k) ?? k, remap(x, ids)]));
  return v;
}

/** Runs one save, saying which part of the file a mistake is in. */
function part<T>(what: string, save: () => T): T {
  try {
    return save();
  } catch (e) {
    throw new DomainError(`${what}: ${(e as Error).message}`);
  }
}

export interface SetupLoaded { tags_added: number; fields_added: number }

export function loadSetup(db: DB, input: unknown): SetupLoaded {
  const parsed = SetupFile.safeParse(input);
  if (!parsed.success) throw new DomainError(parsed.error.issues.find((i) => i.path[0] === 'kind')?.message ?? "that setup file can't be read");
  const file = parsed.data;
  return db.transaction(() => {
    const ids = new Map<string, string>();
    let tagsAdded = 0;
    let fieldsAdded = 0;

    // Tags: the same name here is the same tag; one the file has under another name here takes the file's name.
    for (const t of file.tags) {
      const here = listTags(db);
      const byName = here.find((x) => x.name.toLowerCase() === t.name.trim().toLowerCase());
      const byId = here.find((x) => x.id === t.id);
      const tag = part(`Tag "${t.name}"`, () => byName ?? (byId ? renameTag(db, byId.id, t.name) : ensureTag(db, t.name)));
      if (!byName && !byId) tagsAdded++;
      ids.set(t.id, tag.id);
      if ((here.find((x) => x.id === tag.id)?.never_dial ?? false) !== t.never_dial) setNeverDial(db, tag.id, t.never_dial);
    }

    // Fields, first without their conditions (those can name smart lists, which come next). A formula can name a field
    // further down the file, so formulas go in once the fields they use are there.
    const plain = (f: (typeof file.fields)[number]): CustomFieldInput => ({ label: f.label, type: f.type, options: f.options, formula: f.formula });
    const putField = (f: (typeof file.fields)[number], input: CustomFieldInput) => {
      const here = listCustomFields(db);
      const had = here.find((x) => x.label.toLowerCase() === f.label.toLowerCase()) ?? here.find((x) => x.id === f.id);
      const out = had ? updateCustomField(db, had.id, input) : createCustomField(db, input);
      if (!had) fieldsAdded++;
      ids.set(f.id, out.id);
    };
    for (const f of file.fields.filter((x) => x.type !== 'formula')) part(`Field "${f.label}"`, () => putField(f, plain(f)));
    let waiting = file.fields.filter((x) => x.type === 'formula');
    while (waiting.length) {
      const left = waiting.filter((f) => {
        try {
          putField(f, plain(f));
          return false;
        } catch {
          return true;
        }
      });
      if (left.length === waiting.length) part(`Field "${left[0]!.label}"`, () => putField(left[0]!, plain(left[0]!)));
      waiting = left;
    }

    const s = remap(file, ids) as typeof file;
    part('Smart lists', () => saveStatuses(db, s.statuses));
    for (const f of s.fields.filter((x) => x.show_when || x.required_when)) {
      part(`Field "${f.label}"`, () => updateCustomField(db, f.id, { ...plain(f), show_when: f.show_when, required_when: f.required_when }));
    }
    part('Buttons', () => saveButtons(db, s.buttons));
    part('Tag shortcuts', () => saveTagShortcuts(db, s.tag_shortcuts));
    part('Rules', () => saveRules(db, s.rules));
    part('Funnel steps', () => saveFunnelSteps(db, s.funnel_steps));
    part('Calling settings', () => saveCallingSettings(db, s.calling));
    part('Report layouts', () => saveReportLayouts(db, s.report_layouts));
    part('Report targets', () => saveTargets(db, s.report_targets));
    return { tags_added: tagsAdded, fields_added: fieldsAdded };
  })();
}
