import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';

/** Records a change in audit_log. Call it inside the same transaction as the change. */
export function audit(db: DB, table: string, rowId: string, action: string, oldV: unknown, newV: unknown, at = nowIso()) {
  db.prepare('INSERT INTO audit_log (id, at, table_name, row_id, action, old_json, new_json) VALUES (?,?,?,?,?,?,?)').run(
    uuidv7(), at, table, rowId, action, oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null,
  );
}
