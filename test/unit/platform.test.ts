import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { findClaudeCode, claudeSearchDirs } from '../../src/server/ai/findClaude.js';
import { defaultDataDir } from '../../src/server/config.js';

const files = (...list: string[]) => {
  const set = new Set(list);
  return (p: string) => set.has(p);
};

describe('default data folder', () => {
  it('is "Mortgage CRM" in the home folder on Windows and Mac', () => {
    expect(defaultDataDir({}, 'win32', 'C:\\Users\\al')).toBe(path.join('C:\\Users\\al', 'Mortgage CRM'));
    expect(defaultDataDir({}, 'darwin', '/Users/al')).toBe(path.join('/Users/al', 'Mortgage CRM'));
  });

  it('stays where the Linux install expects it', () => {
    expect(defaultDataDir({}, 'linux', '/home/al')).toBe(path.join('/home/al', '.local', 'share', 'mpcrm'));
    expect(defaultDataDir({ XDG_DATA_HOME: '/data' }, 'linux', '/home/al')).toBe(path.join('/data', 'mpcrm'));
  });
});

describe('finding Claude Code', () => {
  it('looks in Homebrew and ~/.local/bin on a Mac even when PATH is bare (app opened from the Dock)', () => {
    const env = { PATH: '/usr/bin:/bin' };
    expect(findClaudeCode('claude', { env, platform: 'darwin', home: '/Users/al', isFile: files('/opt/homebrew/bin/claude') })).toEqual({ file: '/opt/homebrew/bin/claude', prefix: [] });
    expect(findClaudeCode('claude', { env, platform: 'darwin', home: '/Users/al', isFile: files('/Users/al/.local/bin/claude') })).toEqual({ file: '/Users/al/.local/bin/claude', prefix: [] });
  });

  it('prefers PATH over the usual places', () => {
    const r = findClaudeCode('claude', { env: { PATH: '/x/bin' }, platform: 'linux', home: '/home/al', isFile: files('/x/bin/claude', '/home/al/.local/bin/claude') });
    expect(r?.file).toBe('/x/bin/claude');
  });

  it('finds claude.exe from the Windows installer', () => {
    const r = findClaudeCode('claude', { env: { PATH: 'C:\\Windows' }, platform: 'win32', home: 'C:\\Users\\al', isFile: files('C:\\Users\\al\\.local\\bin\\claude.exe') });
    expect(r).toEqual({ file: 'C:\\Users\\al\\.local\\bin\\claude.exe', prefix: [] });
  });

  it("runs npm's claude.cmd through node, since Node can't start .cmd files without a shell", () => {
    const npm = 'C:\\Users\\al\\AppData\\Roaming\\npm';
    const cli = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    const env = { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\al\\AppData\\Roaming' };
    expect(findClaudeCode('claude', { env, platform: 'win32', home: 'C:\\Users\\al', isFile: files(`${npm}\\claude.cmd`, cli) })).toEqual({ file: 'node', prefix: [cli] });
    // A .cmd without the script next to it can't be run safely, so it counts as not found.
    expect(findClaudeCode('claude', { env, platform: 'win32', home: 'C:\\Users\\al', isFile: files(`${npm}\\claude.cmd`) })).toBeNull();
  });

  it('uses a full path from Settings as given', () => {
    expect(findClaudeCode('/opt/claude/claude', { env: {}, platform: 'linux', home: '/h', isFile: files('/opt/claude/claude') })?.file).toBe('/opt/claude/claude');
    expect(findClaudeCode('D:\\tools\\claude', { env: {}, platform: 'win32', home: 'C:\\h', isFile: files('D:\\tools\\claude.exe') })?.file).toBe('D:\\tools\\claude.exe');
    expect(findClaudeCode('/missing/claude', { env: {}, platform: 'linux', home: '/h', isFile: files() })).toBeNull();
  });

  it('splits PATH with ; on Windows and : elsewhere', () => {
    expect(claudeSearchDirs({ PATH: 'C:\\a;C:\\b' }, 'win32', 'C:\\h').slice(0, 2)).toEqual(['C:\\a', 'C:\\b']);
    expect(claudeSearchDirs({ PATH: '/a:/b' }, 'linux', '/h').slice(0, 2)).toEqual(['/a', '/b']);
  });
});
