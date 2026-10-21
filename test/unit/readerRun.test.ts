import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { run, RUN_LIMITS } from '../../src/server/ai/readers.js';

const node = process.execPath;
const limits = (o: Partial<typeof RUN_LIMITS>) => ({ ...RUN_LIMITS, ...o });
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe('running Claude Code for a page', () => {
  it('returns what the program printed', async () => {
    await expect(run(node, ['-e', 'console.log(JSON.stringify({ok:1}))'], os.tmpdir(), 'claude')).resolves.toContain('{"ok":1}');
  });

  it('gives up after the time limit, and forces the program to stop if it ignores the polite stop', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-run-')), 'pid');
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    await expect(run(node, ['-e', script], os.tmpdir(), 'claude', limits({ timeoutMs: 1_000, killAfterMs: 300 }))).rejects.toThrow(/took more than/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(gone(pid)).toBe(true);
  });

  it('stops a program that prints far more than a page answer', async () => {
    const script = "const s = 'x'.repeat(65536); const w = () => process.stdout.write(s, w); w();";
    await expect(run(node, ['-e', script], os.tmpdir(), 'claude', limits({ maxOutputBytes: 1_000_000, killAfterMs: 300 }))).rejects.toThrow(/far more output/);
  });
});
