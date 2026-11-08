import * as z from 'zod/v4';

// The lead sheet on the Calling screen (the middle panel) as blocks you show, hide and put in order (Automation →
// Calling screen, kept in calling settings as `sheet`). The never-dial warning always comes first when it applies,
// and the outcome buttons can't be hidden, since they save the call.

export const SHEET_BLOCKS = [
  { id: 'lead', label: 'Lead info', help: 'Name, number and the dial button, age, where they are, lender and loan, your fields' },
  { id: 'tags', label: 'Tags and smart lists', help: "The lead's smart lists as badges, and its tags to put on or take off" },
  { id: 'outcome', label: 'Outcome buttons', help: 'Dial counter, caller ID, the buttons, and what a button asks for' },
  { id: 'calls', label: 'Calls', help: 'Calls made to this lead, newest first' },
  { id: 'notes', label: 'Notes', help: 'Your notes on this lead' },
] as const;
export type SheetBlockId = (typeof SHEET_BLOCKS)[number]['id'];

const ids = SHEET_BLOCKS.map((b) => b.id) as [SheetBlockId, ...SheetBlockId[]];

/** The facts under Lead info, in their usual order. Your fields are `field:<id>`, after these unless you move them. */
export const LEAD_FACTS = [
  { id: 'county', label: 'County' },
  { id: 'lead_type', label: 'Lead type' },
  { id: 'called_in', label: 'Called in' },
  { id: 'lead_id', label: 'Lead ID' },
  { id: 'age', label: 'Age' },
  { id: 'dob', label: 'Date of birth' },
  { id: 'lender', label: 'Lender' },
  { id: 'loan', label: 'Loan amount' },
  { id: 'coborrower', label: 'Co-borrower' },
  { id: 'tobacco', label: 'Tobacco' },
  { id: 'address', label: 'Address' },
  { id: 'batch', label: 'Batch' },
  { id: 'attempts', label: 'Attempts' },
  { id: 'health', label: 'Health (from the sheet)' },
  { id: 'extra', label: 'Other columns from the sheet' },
  { id: 'page', label: 'PDF page' },
] as const;

const Shown = z.object({ id: z.string().min(1).max(80), shown: z.boolean() });

export const SheetLayout = z.object({
  blocks: z.array(z.object({ id: z.enum(ids), shown: z.boolean() })).max(SHEET_BLOCKS.length).default([]),
  /** The facts under Lead info, in your order, shown or hidden (see LEAD_FACTS; your fields are `field:<id>`). */
  facts: z.array(Shown).max(200).default([]),
  /** How many of the lead's calls to show, newest first; 0 shows them all. */
  calls_shown: z.number().int().min(0).max(200).default(0),
  /** How many lines tall the box for a new note is. */
  notes_rows: z.number().int().min(1).max(30).default(2),
  /** The dial counter and the timer, above the buttons. */
  dial_counter: z.boolean().default(true),
  /** Which of your numbers you called from. */
  caller_id: z.boolean().default(true),
});
export type SheetLayout = z.infer<typeof SheetLayout>;

/** Every block once, in your order, then any you haven't placed (shown); the outcome buttons are always shown. */
export function sheetBlocks(layout: SheetLayout | undefined): { id: SheetBlockId; shown: boolean }[] {
  const seen = new Set<SheetBlockId>();
  const out: { id: SheetBlockId; shown: boolean }[] = [];
  for (const b of layout?.blocks ?? []) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push({ id: b.id, shown: b.id === 'outcome' || b.shown });
  }
  for (const b of SHEET_BLOCKS) if (!seen.has(b.id)) out.push({ id: b.id, shown: true });
  return out;
}

/** Every fact once, in your order, then any you haven't placed (shown): the usual ones, then your fields. */
export function sheetFacts(layout: SheetLayout | undefined, fieldIds: readonly string[]): { id: string; shown: boolean }[] {
  const all = [...LEAD_FACTS.map((f) => f.id as string), ...fieldIds.map((id) => `field:${id}`)];
  const known = new Set(all);
  const seen = new Set<string>();
  const out: { id: string; shown: boolean }[] = [];
  for (const f of layout?.facts ?? []) {
    if (seen.has(f.id) || !known.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  for (const id of all) if (!seen.has(id)) out.push({ id, shown: true });
  return out;
}

/** A lead sheet you saved by name, to switch to (Automation → Calling screen, or on the Calling screen). */
export const SavedSheet = z.object({ name: z.string().trim().min(1).max(60), sheet: SheetLayout });
export type SavedSheet = z.infer<typeof SavedSheet>;
