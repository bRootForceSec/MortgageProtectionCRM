import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';

// Turns lead pages upright in the PDFs the app keeps (import drafts and imported batches), by changing
// each page's rotation. Nothing on the page is redrawn, so it can always be turned back.

export type Turn = 0 | 90 | 180 | 270;

export function normTurn(deg: number): Turn {
  return ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Turn;
}

const locks = new Map<string, Promise<unknown>>();

/** One change at a time per file. */
function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  void next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  }).catch(() => {});
  return next;
}

/**
 * Turns pages of the PDF at `file` clockwise by the given degrees (page number from 1 → degrees), in place.
 * Returns how many pages were turned. Encrypted PDFs are left alone.
 */
export async function turnPdfPages(file: string, turns: Map<number, number>): Promise<number> {
  const wanted = [...turns].filter(([, t]) => normTurn(t) !== 0);
  if (!wanted.length) return 0;
  return withFileLock(file, async () => {
    const doc = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true });
    if (doc.isEncrypted) return 0;
    const pages = doc.getPages();
    let n = 0;
    for (const [p, t] of wanted) {
      const page = pages[p - 1];
      if (!page) continue;
      page.setRotation(degrees(normTurn(page.getRotation().angle + t)));
      n++;
    }
    if (!n) return 0;
    const out = await doc.save();
    // Written beside it, then swapped in, so a crash never leaves half a file.
    const tmp = `${file}.turning`;
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    await replace(tmp, file);
    return n;
  });
}

/** On Windows the swap fails while the file is being sent to the viewer; try again for a moment. */
async function replace(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e: any) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) {
        fs.rmSync(from, { force: true });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** The PDF a batch was imported from (kept as "<batch id>-<file name>" in the imports folder). */
export function batchPdf(importsDir: string, batchId: string): string | null {
  if (!/^[\w-]+$/.test(batchId)) return null;
  try {
    const f = fs.readdirSync(importsDir).find((n) => n.startsWith(`${batchId}-`) && /\.pdf$/i.test(n));
    return f ? path.join(importsDir, f) : null;
  } catch {
    return null;
  }
}
