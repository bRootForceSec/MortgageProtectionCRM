import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { loadConfig } from '../../src/server/config.js';

const keep = (v?: string) => loadConfig({ MPCRM_DATA_DIR: '/tmp/mpcrm-config-test', ...(v === undefined ? {} : { MPCRM_BACKUP_KEEP: v }) }).backupKeep;

describe('MPCRM_BACKUP_KEEP', () => {
  it('defaults to 30 and accepts a positive whole number', () => {
    expect(keep()).toBe(30);
    expect(keep('')).toBe(30);
    expect(keep('7')).toBe(7);
  });

  it('never goes below 1, so pruning cannot delete the backup just written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(keep('0')).toBe(1);
    expect(keep('-4')).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('falls back to 30 when the value is not a whole number', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(keep('abc')).toBe(30);
    expect(keep('2.5')).toBe(30);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('MPCRM_APP_DIR', () => {
  it('is the Linux service install folder, and null when started by hand', () => {
    expect(loadConfig({ MPCRM_DATA_DIR: '/tmp/mpcrm-config-test' }).appDir).toBeNull();
    expect(loadConfig({ MPCRM_DATA_DIR: '/tmp/mpcrm-config-test', MPCRM_APP_DIR: '/opt/mpcrm/' }).appDir).toBe(path.resolve('/opt/mpcrm'));
  });
});
