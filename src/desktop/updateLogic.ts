import { createHash } from 'node:crypto';
import { load } from 'js-yaml';

// Plain helpers for the desktop updater, kept free of Electron so they can be unit-tested.

export const REPO = { owner: 'bRootForceSec', repo: 'MortgageProtectionCRM' };
export const RELEASES_PAGE = `https://github.com/${REPO.owner}/${REPO.repo}/releases`;

/** -1, 0 or 1. Plain numeric x.y.z versions, which is what the release builds use. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Turns release notes (a "- change" list, possibly as HTML) into one line per change. */
export function notesToChanges(notes: unknown): string[] {
  if (Array.isArray(notes)) return notes.flatMap((n) => notesToChanges(n?.note ?? n));
  if (typeof notes !== 'string') return [];
  const text = notes
    .replace(/<h[1-6][^>]*>/gi, '\n# ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const lines = text.split('\n').map((l) => l.trim());
  // Only the change list: stop at the first heading (the install instructions follow it).
  const end = lines.findIndex((l) => l.startsWith('#'));
  return (end >= 0 ? lines.slice(0, end) : lines)
    .filter((l) => l.startsWith('- ') || l.startsWith('* '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
    .slice(0, 30);
}

export interface MacFeed {
  version: string;
  zip: { url: string; sha512: string; size?: number };
}

/** Reads electron-builder's latest-mac.yml and picks the zip for this Mac's processor. */
export function parseMacFeed(yml: string, arch: string): MacFeed {
  const doc = load(yml) as { version?: string; files?: { url: string; sha512: string; size?: number }[] };
  if (!doc?.version || !Array.isArray(doc.files)) throw new Error('the update information is incomplete');
  const zips = doc.files.filter((f) => f.url.endsWith('.zip'));
  const mine = zips.find((f) => f.url.includes(`-${arch}.`)) ?? (arch === 'x64' ? zips.find((f) => !/arm64/.test(f.url)) : undefined);
  if (!mine) throw new Error(`there is no Mac download for this computer (${arch}) in this version`);
  return { version: String(doc.version), zip: mine };
}

export function sha512Base64(data: Buffer): string {
  return createHash('sha512').update(data).digest('base64');
}

/** The shell script that swaps the Mac app once this copy has quit, then opens the new one. */
export function macSwapScript(pid: number, appBundle: string, newBundle: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    'set -e',
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done`,
    `rm -rf ${q(`${appBundle}.old`)}`,
    `mv ${q(appBundle)} ${q(`${appBundle}.old`)}`,
    `if mv ${q(newBundle)} ${q(appBundle)}; then rm -rf ${q(`${appBundle}.old`)}; else mv ${q(`${appBundle}.old`)} ${q(appBundle)}; fi`,
    `xattr -dr com.apple.quarantine ${q(appBundle)} 2>/dev/null || true`,
    `open ${q(appBundle)}`,
  ].join('\n');
}
