import type { DB } from '../db/connection.js';
import { nowIso } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { audit } from '../core/audit.js';

// Lead types (FE-A, CI-A, …) and their prices. A lead's price follows its type.

export function listLeadTypes(db: DB) {
  return db.prepare('SELECT * FROM lead_type ORDER BY sort_order, code').all();
}

export interface LeadTypePatch {
  label?: string;
  price_cents?: number | null;
  active?: boolean;
  sort_order?: number;
}

/** Adds a lead type (it needs a label) or changes one. Fields left out keep their value. */
export function saveLeadType(db: DB, code: string, b: LeadTypePatch) {
  const now = nowIso();
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM lead_type WHERE code = ?').get(code) as any;
    if (!old) {
      if (!b.label) throw new DomainError('a new lead type needs a name');
      const max = (db.prepare('SELECT max(sort_order) m FROM lead_type').get() as { m: number | null }).m ?? 0;
      db.prepare('INSERT INTO lead_type (code, label, price_cents, sort_order, active, updated_at) VALUES (?,?,?,?,?,?)').run(
        code, b.label, b.price_cents ?? null, b.sort_order ?? max + 10, b.active === false ? 0 : 1, now,
      );
    } else {
      db.prepare(
        'UPDATE lead_type SET label = ?, price_cents = ?, active = ?, sort_order = ?, updated_at = ? WHERE code = ?',
      ).run(
        b.label ?? old.label, b.price_cents !== undefined ? b.price_cents : old.price_cents,
        b.active === undefined ? old.active : b.active ? 1 : 0, b.sort_order ?? old.sort_order, now, code,
      );
    }
    const neu = db.prepare('SELECT * FROM lead_type WHERE code = ?').get(code);
    audit(db, 'lead_type', code, old ? 'update' : 'insert', old, neu, now);
    return neu;
  })();
}
