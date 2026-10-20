import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Finds the Claude Code program on Windows, Mac and Linux.
// An app opened from the Mac Dock or a desktop shortcut doesn't get your terminal's PATH, so Homebrew and
// ~/.local/bin aren't searched unless we look there ourselves. On Windows the npm install is a .cmd file,
// which Node can't start without a shell, so we run its JavaScript entry point with node instead.

export interface ClaudeCommand {
  /** Program to start. */
  file: string;
  /** Arguments that go before Claude Code's own arguments. */
  prefix: string[];
}

export interface FindOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  isFile?: (p: string) => boolean;
}

const defaultIsFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function claudeSearchDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fromPath = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extra =
    platform === 'win32'
      ? [p.join(home, '.local', 'bin'), env.APPDATA ? p.join(env.APPDATA, 'npm') : null]
      : [
          p.join(home, '.local', 'bin'),
          p.join(home, '.claude', 'local'),
          p.join(home, '.npm-global', 'bin'),
          ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
          '/usr/local/bin',
          '/usr/bin',
        ];
  return [...new Set([...fromPath, ...extra.filter((d): d is string => !!d)])];
}

/** Returns how to start Claude Code, or null when it can't be found. `command` is the setting: a name or a full path. */
export function findClaudeCode(command: string, opts: FindOptions = {}): ClaudeCommand | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const isFile = opts.isFile ?? defaultIsFile;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const win = platform === 'win32';

  const candidates: string[] = [];
  const names = win && !p.extname(command) ? [`${command}.exe`, `${command}.cmd`] : [command];
  if (command.includes('/') || (win && command.includes('\\'))) {
    candidates.push(...names);
  } else {
    for (const dir of claudeSearchDirs(env, platform, home)) for (const n of names) candidates.push(p.join(dir, n));
  }

  for (const c of candidates) {
    if (!isFile(c)) continue;
    const ext = p.extname(c).toLowerCase();
    if (win && (ext === '.cmd' || ext === '.bat')) {
      // npm's shim sits next to node_modules/@anthropic-ai/claude-code; run its entry point directly.
      const cli = p.join(p.dirname(c), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      if (isFile(cli)) return { file: 'node', prefix: [cli] };
      continue;
    }
    return { file: c, prefix: [] };
  }
  return null;
}

export function claudeNotFoundMessage(command: string, platform: NodeJS.Platform = process.platform): string {
  const how = platform === 'win32' ? 'Install Claude Code with its Windows installer' : 'Install Claude Code';
  return `Couldn't find Claude Code ("${command}"). ${how}, or enter its full path in Settings.`;
}
