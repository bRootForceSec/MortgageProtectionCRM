import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/** UUIDv7: time-ordered, so ids sort by creation time and merge safely across machines. */
export function uuidv7(now = Date.now()): string {
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff;
  } else {
    lastMs = now;
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}
