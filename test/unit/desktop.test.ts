import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linuxLaunchCommand, linuxLoginItem } from '../../src/desktop/autostart.js';
import { otherRunningCopy } from '../../src/server/server.js';

describe('desktop app: start at login on Linux', () => {
  it('starts the AppImage hidden when run from one', () => {
    expect(linuxLaunchCommand({ APPIMAGE: '/home/al/Apps/CRM.AppImage' }, '/tmp/.mount/crm', null)).toBe('"/home/al/Apps/CRM.AppImage" --hidden');
    expect(linuxLaunchCommand({}, '/usr/bin/electron', '/src/app')).toBe('"/usr/bin/electron" "/src/app" --hidden');
  });

  it('writes and removes the autostart entry', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-auto-')), 'autostart', 'crm.desktop');
    const item = linuxLoginItem('"/x/CRM.AppImage" --hidden', file);
    expect(item.get()).toBe(false);
    item.set(true);
    expect(item.get()).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('Exec="/x/CRM.AppImage" --hidden');
    item.set(false);
    expect(item.get()).toBe(false);
  });
});

describe('one copy per data folder', () => {
  it('sees another running copy, and ignores its own or a dead one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpcrm-pid-'));
    expect(otherRunningCopy(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'server.pid'), String(process.pid));
    expect(otherRunningCopy(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'server.pid'), String(process.ppid));
    expect(otherRunningCopy(dir)).toBe(process.ppid);
    fs.writeFileSync(path.join(dir, 'server.pid'), '99999999');
    expect(otherRunningCopy(dir)).toBeNull();
  });
});

describe('desktop updates through the shared update page', () => {
  it('reports the desktop updater and answers before it starts installing', async () => {
    const { Updates } = await import('../../src/server/updates.js');
    let applied = 0;
    const staged = { commit: '0.2.58', from: '0.2.57', changes: ['Faster calling'], at: 'now' };
    const provider = { status: () => ({ staged, last_check: null, last_apply: null }), check: async () => {}, apply: async () => void applied++ };
    const u = new Updates(null, { commit: 'abc', version: '0.2.57', built_at: null }, undefined, 'desktop', provider);
    expect(u.status()).toMatchObject({ managed: true, runtime: 'desktop', staged, current: { version: '0.2.57' } });
    await u.apply();
    // Installing stops the server, so the request is answered first and the install starts a moment later.
    expect(applied).toBe(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(applied).toBe(1);
  });
});
