// Import draft shapes the server stores and the UI shows.

/** Where a draft row stands in your review. */
export type Review = 'auto' | 'needs_review' | 'ok' | 'discarded';

/** How far reading a draft has got. */
export interface DraftProgress {
  phase: 'text' | 'ai' | 'done';
  total: number;
  text_done: number;
  ai_total: number;
  ai_done: number;
  ai_failed: number;
  cost_usd: number;
  reader: string | null;
  error?: string | null;
}
