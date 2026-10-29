import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHORTCUT_ACTIONS } from '../../src/shared/callingSettings.js';
import { OUTCOMES, savesInstantly, type OutcomeDef } from '../../src/shared/outcomes.js';
import { keyLabel } from '../../src/web/shortcuts.js';

// The README's key table is written from the shortcut list and the outcome registry, so it can't go stale.
// If this fails after you change a key or an outcome, run `UPDATE_README=1 npx vitest run test/unit/readmeKeys.test.ts`.

const START = '<!-- keys:start (written by test/unit/readmeKeys.test.ts) -->';
const END = '<!-- keys:end -->';

const keys = (ks: readonly string[]) => ks.map((k) => `\`${keyLabel(k)}\``).join(' ');

function outcomeRow(side: string, kind: OutcomeDef['kind']): string {
  const os = Object.values(OUTCOMES as Record<string, OutcomeDef>)
    .filter((o) => o.active && o.kind === kind && o.hotkey)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const instant = os.filter((o) => savesInstantly({ requires_callback_time: o.callback, counts_as_human_contact: o.pickup }));
  const list = os.map((o) => `\`${o.hotkey}\` ${o.label}`).join(', ');
  const note = instant.length ? ` (${instant.map((o) => o.label).join(' and ')} ${instant.length > 1 ? 'save' : 'saves'} straight away, unless you change it in Settings)` : '';
  return `| \`${os[0]!.hotkey}\`–\`${os.at(-1)!.hotkey}\` | ${side} outcome: ${list}${note} |`;
}

function keyTable(): string {
  return [
    '| Key | Action |',
    '|---|---|',
    ...Object.values(SHORTCUT_ACTIONS).map((a) => `| ${keys(a.keys)} | ${a.label} |`),
    outcomeRow('First call', 'first_call'),
    outcomeRow('Appointment', 'appointment'),
    '| `Enter` | Save the outcome and go to the next lead |',
    '| `Esc` | Cancel |',
  ].join('\n');
}

describe('README key table', () => {
  it('matches the shortcut list and the outcome registry', () => {
    const path = join(import.meta.dirname, '../../README.md');
    const readme = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const a = readme.indexOf(START);
    const b = readme.indexOf(END);
    expect(a, 'README.md needs the keys:start and keys:end markers').toBeGreaterThan(-1);
    const want = `${START}\n${keyTable()}\n${END}`;
    const have = readme.slice(a, b + END.length);
    if (have !== want && process.env.UPDATE_README) writeFileSync(path, readme.slice(0, a) + want + readme.slice(b + END.length));
    else expect(have).toBe(want);
  });
});
