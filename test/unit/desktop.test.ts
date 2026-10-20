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
