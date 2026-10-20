import { describe, it, expect } from 'vitest';
import { nextBackupTime, backupOverdue } from '../../src/server/backupSchedule.js';

describe('nightly backup in the desktop app', () => {
  it('runs at the next 11:30 PM', () => {
    const morning = new Date(2026, 9, 20, 9, 0);
    expect(nextBackupTime(morning)).toEqual(new Date(2026, 9, 20, 23, 30));
    const late = new Date(2026, 9, 20, 23, 45);
    expect(nextBackupTime(late)).toEqual(new Date(2026, 9, 21, 23, 30));
    expect(nextBackupTime(new Date(2026, 9, 20, 23, 30))).toEqual(new Date(2026, 9, 21, 23, 30));
  });

  it('catches up when there is no backup from the last 24 hours', () => {
    const now = new Date(2026, 9, 20, 9, 0);
    expect(backupOverdue(null, now)).toBe(true);
    expect(backupOverdue(new Date(2026, 9, 19, 23, 30), now)).toBe(false);
    expect(backupOverdue(new Date(2026, 9, 18, 23, 30), now)).toBe(true);
  });
});
