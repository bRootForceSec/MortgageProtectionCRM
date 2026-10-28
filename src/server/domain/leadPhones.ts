import type { Statement } from 'better-sqlite3';
import type { DB } from '../db/connection.js';
import type { OtherPhone } from '../../shared/phones.js';

// A lead's numbers besides the main one (lead_other_phone), in the order shown.

const prepared = new WeakMap<DB, { list: Statement; ins: Statement }>();
function stmts(db: DB) {
  let s = prepared.get(db);
  if (!s) {
    s = {
      list: db.prepare('SELECT raw, e164, label FROM lead_other_phone WHERE lead_id = ? ORDER BY pos'),
      ins: db.prepare('INSERT INTO lead_other_phone (lead_id, pos, raw, e164, label) VALUES (?,?,?,?,?)'),
    };
    prepared.set(db, s);
  }
  return s;
}

export function otherPhones(db: DB, leadId: string): OtherPhone[] {
  return stmts(db).list.all(leadId) as OtherPhone[];
}

/** Replaces the lead's other numbers with this list, inside the caller's transaction. */
export function writeOtherPhones(db: DB, leadId: string, phones: OtherPhone[]) {
  db.prepare('DELETE FROM lead_other_phone WHERE lead_id = ?').run(leadId);
  const { ins } = stmts(db);
  phones.forEach((p, i) => ins.run(leadId, i + 1, p.raw, p.e164, p.label));
}

/** One line for the change log: "Alternate +13175550100, +13175550101". */
export function describePhones(phones: OtherPhone[]): string | null {
  return phones.map((p) => `${p.label ? `${p.label} ` : ''}${p.e164 ?? p.raw ?? ''}`.trim()).join(', ') || null;
}
