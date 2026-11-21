import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { claudeCodeReader, checkClaudeCode, needsSignIn, AiSignInError, AiError } from '../../src/server/ai/readers.js';

// A stand-in for Claude Code: a script that prints what the real one prints when its login has expired.
function fakeClaude(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-fakeclaude-'));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return file;
}

const expired = JSON.stringify({
  type: 'result', is_error: true,
  result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}',
});

describe.skipIf(process.platform === 'win32')('Claude Code signed out', () => {
  it('knows the signed-out messages, and not ordinary ones', () => {
    expect(needsSignIn('OAuth token has expired')).toBe(true);
    expect(needsSignIn('Invalid API key · Please run /login')).toBe(true);
    expect(needsSignIn('Not logged in · Please run /login')).toBe(true);
    expect(needsSignIn('Prompt is too long')).toBe(false);
    expect(needsSignIn('overloaded_error')).toBe(false);
  });

  it('a page read says to sign in again, whether Claude Code answers with an error or stops with one', async () => {
    const answers = claudeCodeReader(fakeClaude(`console.log(${JSON.stringify(expired)})`), 'haiku');
    const err = await answers.read(new Uint8Array([1])).catch((e) => e);
    expect(err).toBeInstanceOf(AiSignInError);
    expect(err.message).toMatch(/signed out.*\/login/);

    const stops = claudeCodeReader(fakeClaude("console.error('Invalid API key · Please run /login'); process.exit(1)"), 'haiku');
    await expect(stops.read(new Uint8Array([1]))).rejects.toBeInstanceOf(AiSignInError);

    const other = claudeCodeReader(fakeClaude("console.error('something else broke'); process.exit(1)"), 'haiku');
    const e2 = await other.read(new Uint8Array([1])).catch((e) => e);
    expect(e2).toBeInstanceOf(AiError);
    expect(e2).not.toBeInstanceOf(AiSignInError);
  });

  it('"Check it works" finds a signed-out Claude Code, and passes a signed-in one', async () => {
    expect(await checkClaudeCode(fakeClaude(`console.log(${JSON.stringify(expired)})`), 'haiku')).toMatchObject({ ok: false, message: expect.stringMatching(/signed out/) });
    expect(await checkClaudeCode(fakeClaude("console.log(JSON.stringify({ type: 'result', is_error: false, result: 'OK' }))"), 'haiku')).toMatchObject({ ok: true });
    expect(await checkClaudeCode('/nowhere/claude', 'haiku')).toMatchObject({ ok: false, message: expect.stringMatching(/Couldn't find/) });
  });
});
