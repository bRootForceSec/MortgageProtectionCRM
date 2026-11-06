import * as z from 'zod/v4';

// Reports is a page of cards you arrange yourself: which show, in what order, and as a chart or a table where a card
// has both. Your arrangement and the presets you save are kept in the `report_layouts` setting (domain/reportLayouts.ts).

export const REPORT_CARDS = {
  activity: { label: 'Activity' },
  by_caller: { label: 'Local vs out-of-area caller ID' },
  benchmarks: { label: 'By lead type' },
  appointments: { label: 'Appointments' },
  weekly: { label: 'Week by week' },
  best_time: { label: 'Best time to call' },
  by_hour: { label: 'By hour', views: ['chart', 'table'] },
  by_county: { label: 'By county' },
  by_batch: { label: 'By batch' },
  objections: { label: 'Objections' },
  by_age: { label: 'By lead age', hidden: true },
} as const satisfies Record<string, { label: string; hidden?: boolean; views?: readonly ('chart' | 'table')[] }>;

export type ReportCardKey = keyof typeof REPORT_CARDS;
export type ReportView = 'chart' | 'table';

export const ReportCard = z.object({
  key: z.string().max(40),
  hidden: z.boolean().default(false),
  view: z.enum(['chart', 'table']).optional(),
});
export type ReportCard = z.infer<typeof ReportCard>;

export const ReportLayout = z.array(ReportCard).max(50);
export type ReportLayout = z.infer<typeof ReportLayout>;

export const ReportLayouts = z.object({
  /** The arrangement showing now. */
  current: ReportLayout.default([]),
  /** Arrangements you saved under a name, to load when you want. */
  presets: z.record(z.string().trim().min(1).max(40), ReportLayout).default({}),
});
export type ReportLayouts = z.infer<typeof ReportLayouts>;

const isCard = (k: string): k is ReportCardKey => Object.hasOwn(REPORT_CARDS, k);

/**
 * A layout with every card in it, once: yours first in your order (unknown keys dropped), then any card you haven't
 * placed yet, in the default order and shown unless it starts hidden. So a card added later shows up on its own.
 */
export function fullLayout(layout: ReportLayout): (ReportCard & { key: ReportCardKey })[] {
  const seen = new Set<string>();
  const out: (ReportCard & { key: ReportCardKey })[] = [];
  for (const c of layout) {
    if (!isCard(c.key) || seen.has(c.key)) continue;
    seen.add(c.key);
    out.push({ ...c, key: c.key });
  }
  for (const [key, def] of Object.entries(REPORT_CARDS) as [ReportCardKey, { hidden?: boolean }][]) {
    if (!seen.has(key)) out.push({ key, hidden: !!def.hidden });
  }
  return out;
}

/** The view a card shows in: yours if the card has it, else its first one. */
export function cardView(c: ReportCard): ReportView | null {
  const views: readonly ReportView[] | undefined = isCard(c.key) ? (REPORT_CARDS[c.key] as { views?: readonly ReportView[] }).views : undefined;
  if (!views) return null;
  return c.view && views.includes(c.view) ? c.view : views[0]!;
}
