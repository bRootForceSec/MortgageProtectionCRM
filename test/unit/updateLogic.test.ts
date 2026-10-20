import { describe, it, expect } from 'vitest';
import { compareVersions, notesToChanges, parseMacFeed, macSwapScript, sha512Base64 } from '../../src/desktop/updateLogic.js';

describe('desktop updater helpers', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1);
    expect(compareVersions('v0.2.9', '0.2.10')).toBe(-1);
    expect(compareVersions('0.2.9', '0.2.9')).toBe(0);
    expect(compareVersions('1.0', '0.9.99')).toBe(1);
  });

  it('reads the change list from release notes, plain or HTML', () => {
    expect(notesToChanges('Changes:\n- Calling: faster\n- Fix backup\n\nother text')).toEqual(['Calling: faster', 'Fix backup']);
    expect(notesToChanges('<ul><li>Calling &amp; reports</li><li>Fix</li></ul>')).toEqual(['Calling & reports', 'Fix']);
    expect(notesToChanges([{ version: '1', note: '- One' }, { version: '2', note: '- Two' }])).toEqual(['One', 'Two']);
    expect(notesToChanges(null)).toEqual([]);
    // The install steps after the heading aren't changes.
    expect(notesToChanges('Changes:\n\n- One\n\n## Install\n\n- **Windows**: run it')).toEqual(['One']);
    expect(notesToChanges('<ul><li>One</li></ul><h2>Install</h2><ul><li>Windows</li></ul>')).toEqual(['One']);
  });

  it("picks the Mac zip for this computer's processor", () => {
    const yml = [
      'version: 0.2.57',
      'files:',
      '  - url: Mortgage-Protection-CRM-0.2.57-mac-arm64.zip',
      '    sha512: AAA',
      '    size: 10',
      '  - url: Mortgage-Protection-CRM-0.2.57-mac-x64.zip',
      '    sha512: BBB',
      '  - url: Mortgage-Protection-CRM-0.2.57-mac-arm64.dmg',
      '    sha512: CCC',
      'path: Mortgage-Protection-CRM-0.2.57-mac-arm64.zip',
    ].join('\n');
    expect(parseMacFeed(yml, 'arm64')).toEqual({ version: '0.2.57', zip: { url: 'Mortgage-Protection-CRM-0.2.57-mac-arm64.zip', sha512: 'AAA', size: 10 } });
    expect(parseMacFeed(yml, 'x64').zip.sha512).toBe('BBB');
    expect(() => parseMacFeed('version: 1', 'arm64')).toThrow(/incomplete/);
  });

  it('checks downloads with SHA-512 like electron-builder writes it', () => {
    expect(sha512Base64(Buffer.from('abc'))).toBe('3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==');
  });

  it('swaps the Mac app safely, putting the old one back if the move fails', () => {
    const s = macSwapScript(123, "/Applications/Mortgage Protection CRM.app", "/tmp/new/Mortgage Protection CRM.app");
    expect(s).toContain('while kill -0 123');
    expect(s).toContain("mv '/Applications/Mortgage Protection CRM.app' '/Applications/Mortgage Protection CRM.app.old'");
    expect(s).toContain("open '/Applications/Mortgage Protection CRM.app'");
  });
});
