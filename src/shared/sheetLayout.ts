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

export const SheetLayout = z.object({
  blocks: z.array(z.object({ id: z.enum(ids), shown: z.boolean() })).max(SHEET_BLOCKS.length).default([]),
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
