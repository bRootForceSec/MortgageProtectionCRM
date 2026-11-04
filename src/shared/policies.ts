// Policies and comp: what a Unitrust status means for profit, and the commission formula. Shared so Reports, the lead
// page and Settings agree. Nothing here is about a particular carrier; the rules for each product are yours (Settings).

export const PRODUCT_KINDS = [
  { key: 'term', label: 'Term' },
  { key: 'final_expense', label: 'Final expense' },
  { key: 'other', label: 'Other' },
] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number]['key'];
export const productKindLabel = (k: string | null | undefined) => PRODUCT_KINDS.find((x) => x.key === k)?.label ?? '';

/**
 * How a policy counts: paid (in profit), pending (an estimate, not in profit) or out (declined, withdrawn...).
 * A lapsed policy still counts as paid, since chargebacks aren't tracked.
 */
export type PolicyStage = 'paid' | 'pending' | 'out';

const OUT = /declin|withdr|not taken|closed|incomplete|cancel|reject|postpon|rescind/i;
const NOT_PAID = /not\s*paid|unpaid/i;
const PAID = /paid|lapse|in\s*force/i;
const PENDING = /submit|pending|received|underwrit|review|approved|issued|initial premium|requirement|app(lication)?\b|draft|signed/i;

/** The stage of a status as Unitrust shows it. `known` is false for a status none of the rules recognize (counted as pending). */
export function policyStage(status: string | null | undefined): { stage: PolicyStage; known: boolean } {
  const s = (status ?? '').trim();
  if (!s) return { stage: 'pending', known: false };
  if (OUT.test(s)) return { stage: 'out', known: true };
  if (NOT_PAID.test(s)) return { stage: 'pending', known: true };
  if (PAID.test(s)) return { stage: 'paid', known: true };
  return { stage: 'pending', known: PENDING.test(s) };
}

export interface CompRules {
  comp_hit_points: number | null;
  advance_pct: number | null;
}

/** Whether a product has every rule needed to work out commission. */
export const hasRules = (p: CompRules) => p.comp_hit_points != null && p.advance_pct != null;

/**
 * The advance on a policy, in cents: AP × (comp level − comp hit) % × advance %. Null when a rule or the level is
 * missing. Never below zero.
 */
export function commissionCents(apCents: number | null | undefined, level: number | null | undefined, p: CompRules): number | null {
  if (apCents == null || level == null || !hasRules(p)) return null;
  const comp = Math.max(0, level - p.comp_hit_points!);
  return Math.round((apCents * comp * p.advance_pct!) / 10_000);
}
