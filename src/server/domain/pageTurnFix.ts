import fs from 'node:fs';
import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { AiError, type PageReader } from '../ai/readers.js';
import { pdfTextTurns, extractPage } from './pdfReader.js';
import { batchPdf, turnPdfPages, normTurn } from './pageTurn.js';

// One-time fix: leads imported before pages were turned upright on import. Goes through each imported
// PDF once, turns typed pages by the direction of their text, and asks the AI reader (when one is set up)
// which way up each scanned page is. A batch is marked done only when every lead page in it was settled,
// so a page the AI couldn't answer for is tried again next time the app starts.

const DONE_KEY = 'fix.page_turns_v1';

export interface PageTurnFixResult {
  batches: number;
  pages_turned: number;
  left_for_later: number;
}

export async function fixImportedPageTurns(
  db: DB,
  importsDir: string,
  reader: PageReader | null,
  opts: {
    log?: (msg: string) => void;
    alive?: () => boolean;
    /** Check every imported PDF again, even ones checked before. */
    all?: boolean;
    onProgress?: (p: PageTurnFixResult & { files_done: number; files_total: number }) => void;
  } = {},
): Promise<PageTurnFixResult> {
  const log = opts.log ?? (() => {});
  const alive = opts.alive ?? (() => true);
  const done = new Set(getSetting<string[]>(db, DONE_KEY) ?? []);
  const batches = (db.prepare('SELECT DISTINCT batch_id FROM lead WHERE source_page IS NOT NULL').all() as { batch_id: string }[])
    .map((b) => b.batch_id)
    .filter((b) => opts.all || !done.has(b));
  const result: PageTurnFixResult = { batches: 0, pages_turned: 0, left_for_later: 0 };
  let aiWorks = !!reader;
  let filesDone = 0;
  const progress = () => opts.onProgress?.({ ...result, files_done: filesDone, files_total: batches.length });
  progress();
  for (const batchId of batches) {
    if (!alive()) break;
    if (filesDone > 0) progress();
    filesDone++;
    const file = batchPdf(importsDir, batchId);
    if (!file) {
      done.add(batchId); // The PDF isn't kept, so there's no page to show or turn.
      continue;
    }
    let settled = true;
    try {
      const bytes = new Uint8Array(fs.readFileSync(file));
      const textTurns = await pdfTextTurns(bytes);
      const pages = (db.prepare('SELECT DISTINCT source_page p FROM lead WHERE batch_id = ? AND source_page IS NOT NULL ORDER BY p').all(batchId) as { p: number }[])
        .map((r) => r.p)
        .filter((p) => p >= 1 && p <= textTurns.length);
      const turns = new Map<number, number>();
      for (const p of pages) {
        if (!alive()) return result;
        const t = textTurns[p - 1];
        if (t != null) {
          if (t) turns.set(p, t);
          continue;
        }
        // A scan: only the AI can tell which way up it is.
        if (!reader) continue; // Nothing more to do without one; the Turn button on the lead page saves a turn.
        if (!aiWorks) {
          settled = false;
          continue;
        }
        try {
          const a = await reader.read(await extractPage(bytes, p));
          const turn = normTurn(Number(a.answer.turn ?? 0) || 0);
          if (turn) turns.set(p, turn);
        } catch (e) {
          if (!(e instanceof AiError)) throw e;
          log(`page turn fix: the AI couldn't look at page ${p} of ${file} (${e.message}); will try again next start`);
          aiWorks = false; // Most likely Settings or the connection; don't spend the rest of the run on it.
          settled = false;
        }
      }
      result.pages_turned += await turnPdfPages(file, turns);
      result.batches++;
    } catch (e: any) {
      log(`page turn fix: couldn't fix ${file}: ${e?.message ?? e}`);
      settled = false;
    }
    if (settled) done.add(batchId);
    else result.left_for_later++;
    setSetting(db, DONE_KEY, [...done]);
  }
  if (alive()) setSetting(db, DONE_KEY, [...done]);
  progress();
  return result;
}

export interface PageCheckStatus {
  running: boolean;
  /** Started from the button (every file), not the one-time check on start. */
  all: boolean;
  files_done: number;
  files_total: number;
  pages_turned: number;
  left_for_later: number;
  finished_at: string | null;
  error: string | null;
}

/** Runs the page check one at a time (the start-up fix and the "Check all lead pages" button share it). */
export class PageChecker {
  private current: Promise<void> | null = null;
  private stopped = false;
  state: PageCheckStatus = { running: false, all: false, files_done: 0, files_total: 0, pages_turned: 0, left_for_later: 0, finished_at: null, error: null };

  constructor(
    private db: DB,
    private importsDir: string,
    private reader: () => PageReader | null,
    private log: (msg: string) => void = () => {},
  ) {}

  /** Starts a check unless one is running. Returns when it finishes. */
  start(all: boolean): Promise<void> {
    if (this.current) return this.current;
    this.state = { ...this.state, running: true, all, files_done: 0, files_total: 0, pages_turned: 0, left_for_later: 0, error: null };
    this.current = fixImportedPageTurns(this.db, this.importsDir, this.reader(), {
      all,
      log: this.log,
      alive: () => !this.stopped,
      onProgress: (p) => Object.assign(this.state, p),
    })
      .then(() => undefined)
      .catch((e) => {
        this.state.error = String(e?.message ?? e);
        this.log(`page check failed: ${this.state.error}`);
      })
      .finally(() => {
        this.state.running = false;
        this.state.finished_at = new Date().toISOString();
        this.current = null;
      });
    return this.current;
  }

  stop() {
    this.stopped = true;
  }
}
