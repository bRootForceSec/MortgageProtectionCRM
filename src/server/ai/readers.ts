import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { findClaudeCode, claudeNotFoundMessage } from './findClaude.js';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { PAGE_PROMPT, PageAnswer, answerJsonSchema } from './prompt.js';
import type { AiSettings, Secrets } from './settings.js';

// AI readers for one lead page (a single-page PDF). Each returns the same answer shape, so the
// rest of the import doesn't care which one ran. Pick one in Settings.

export interface AiResult {
  answer: PageAnswer;
  /** "ai:<provider>:<model>", saved on the row so the import can be traced later. */
  extractor: string;
  cost_usd: number | null;
}

export class AiError extends Error {}

export interface PageReader {
  name: string;
  read(pagePdf: Uint8Array): Promise<AiResult>;
}

const TIMEOUT_MS = 180_000;

export function makeReader(s: AiSettings, secrets: Secrets): PageReader | null {
  switch (s.provider) {
    case 'claude_code':
      return claudeCodeReader(s.claude_code.command, s.claude_code.model);
    case 'anthropic_api':
      return anthropicReader(s.anthropic_api.model, secrets.get('anthropic_api_key'));
    case 'openai_compatible':
      return openAiCompatibleReader(s.openai_compatible.base_url, s.openai_compatible.model, secrets.get('openai_api_key'));
    default:
      return null;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-page-'));
}

/** Uses the Claude Code app on this computer, signed in to your Claude account. It may only read the page file. */
export function claudeCodeReader(command: string, model: string): PageReader {
  return {
    name: `ai:claude_code:${model}`,
    async read(pagePdf) {
      const dir = tempDir();
      try {
        fs.writeFileSync(path.join(dir, 'page.pdf'), pagePdf);
        const args = [
          '-p', '--model', model, '--output-format', 'json',
          '--tools', 'Read', '--allowedTools', 'Read',
          '--no-session-persistence', '--permission-mode', 'dontAsk',
          '--json-schema', JSON.stringify(answerJsonSchema()),
          `${PAGE_PROMPT}\n\nThe page is the file page.pdf in the current folder. Read it with the Read tool.`,
        ];
        const found = findClaudeCode(command);
        if (!found) throw new AiError(claudeNotFoundMessage(command));
        const out = await run(found.file, [...found.prefix, ...args], dir, command);
        let parsed: any;
        try {
          parsed = JSON.parse(out);
        } catch {
          throw new AiError(`Claude Code gave an answer that isn't JSON: ${out.slice(0, 200)}`);
        }
        if (parsed.is_error) throw new AiError(`Claude Code: ${String(parsed.result ?? 'error').slice(0, 300)}`);
        const answer = PageAnswer.safeParse(parsed.structured_output);
        if (!answer.success) throw new AiError('Claude Code answered in the wrong shape');
        return { answer: answer.data, extractor: `ai:claude_code:${model}`, cost_usd: parsed.total_cost_usd ?? null };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Limits for one Claude Code run. Exported for tests. */
export const RUN_LIMITS = {
  timeoutMs: TIMEOUT_MS,
  // A page's answer is a few KB; anything near this means something is wrong.
  maxOutputBytes: 10 * 1024 * 1024,
  // After the polite stop, how long to wait before forcing it.
  killAfterMs: 5_000,
};

export function run(file: string, args: string[], cwd: string, command: string, limits = RUN_LIMITS): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(new AiError(`couldn't start "${command}": ${(e as Error).message}`));
      return;
    }
    let out = '';
    let err = '';
    // Asks the process to stop, then forces it if it is still running a few seconds later.
    let stopping = false;
    const stop = (why: string) => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, limits.killAfterMs).unref();
      reject(new AiError(why));
    };
    const timer = setTimeout(() => stop(`the AI took more than ${Math.round(limits.timeoutMs / 60_000)} minutes on this page`), limits.timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > limits.maxOutputBytes) stop('Claude Code sent far more output than a page answer');
    });
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-limits.maxOutputBytes);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new AiError(
          e.code === 'ENOENT'
            ? `couldn't find "${command}". Install Claude Code, or set its full path in Settings.`
            : `couldn't start "${command}": ${e.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim().startsWith('{')) resolve(out);
      else reject(new AiError(`"${command}" stopped with code ${code}: ${(err || out).trim().slice(0, 300)}`));
    });
  });
}

/** Anthropic API with your own key. */
export function anthropicReader(model: string, apiKey: string | null): PageReader {
  return {
    name: `ai:anthropic_api:${model}`,
    async read(pagePdf) {
      if (!apiKey) throw new AiError('no Anthropic API key saved. Add one in Settings.');
      const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 2 });
      let msg;
      try {
        msg = await client.messages.parse({
          model,
          max_tokens: 2048,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(pagePdf).toString('base64') } },
                { type: 'text', text: PAGE_PROMPT },
              ],
            },
          ],
          output_config: { format: zodOutputFormat(PageAnswer) },
        });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new AiError('the Anthropic API key was refused. Check it in Settings.');
        if (e instanceof Anthropic.APIError) throw new AiError(`Anthropic API: ${e.message}`);
        throw e;
      }
      if (msg.stop_reason === 'refusal') throw new AiError('the model declined to read this page');
      if (!msg.parsed_output) throw new AiError(`the model's answer was cut off (${msg.stop_reason})`);
      return { answer: msg.parsed_output, extractor: `ai:anthropic_api:${model}`, cost_usd: null };
    },
  };
}

const execFileP = promisify(execFile);

/** A local model (Ollama, LM Studio, llama.cpp) or any server with an OpenAI-style chat API. Needs a vision model. */
export function openAiCompatibleReader(baseUrl: string, model: string, apiKey: string | null): PageReader {
  return {
    name: `ai:openai_compatible:${model}`,
    async read(pagePdf) {
      if (!model) throw new AiError('choose a model for the local / OpenAI-compatible reader in Settings');
      const dir = tempDir();
      let png: string;
      try {
        fs.writeFileSync(path.join(dir, 'page.pdf'), pagePdf);
        try {
          await execFileP('pdftoppm', ['-r', '150', '-png', '-singlefile', 'page.pdf', 'page'], { cwd: dir, timeout: 60_000 });
        } catch {
          throw new AiError('turning the page into an image needs pdftoppm (Fedora: sudo dnf install poppler-utils)');
        }
        png = fs.readFileSync(path.join(dir, 'page.png')).toString('base64');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `${PAGE_PROMPT}\n\nAnswer with JSON only, matching this schema:\n${JSON.stringify(answerJsonSchema())}` },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
              ],
            },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'lead_page', schema: answerJsonSchema(), strict: true } },
        }),
      }).catch((e: Error) => {
        throw new AiError(`couldn't reach ${baseUrl}: ${e.message}`);
      });
      if (!res.ok) throw new AiError(`${baseUrl} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as any;
      const text = String(body?.choices?.[0]?.message?.content ?? '').replace(/^```(json)?\s*|\s*```$/g, '');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiError("the model's answer isn't JSON");
      }
      const answer = PageAnswer.safeParse(json);
      if (!answer.success) throw new AiError('the model answered in the wrong shape');
      return { answer: answer.data, extractor: `ai:openai_compatible:${model}`, cost_usd: null };
    },
  };
}
