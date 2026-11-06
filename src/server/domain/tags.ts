import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { audit } from '../core/audit.js';
import { matchingLeadIds, type LeadFilter } from './callList.js';

// Tags: your own labels on leads. A lead has any number. Adding or taking one off a lead is kept in the lead's
// change history (lead_change, field "tag"); making, renaming and deleting tags go in the audit log.

export interface Tag {
  id: string;
  name: string;
  /** How many leads have it. */
  leads: number;
}

export function listTags(db: DB): Tag[] {
  return db
    .prepare('SELECT t.id, t.name, (SELECT COUNT(*) FROM lead_tag x WHERE x.tag_id = t.id) leads FROM tag t ORDER BY t.name COLLATE NOCASE')
    .all() as Tag[];
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new DomainError('give the tag a name');
  if (n.length > 40) throw new DomainError('keep the tag name under 40 characters');
  return n;
}

function tagByName(db: DB, name: string): { id: string; name: string } | undefined {
  return db.prepare('SELECT id, name FROM tag WHERE name = ?').get(name) as { id: string; name: string } | undefined;
}

function tagById(db: DB, id: string): { id: string; name: string } {
  const t = db.prepare('SELECT id, name FROM tag WHERE id = ?').get(id) as { id: string; name: string } | undefined;
  if (!t) throw new DomainError('that tag is gone', 404);
  return t;
}

/** The tag with this name (any case), made if there isn't one. */
export function ensureTag(db: DB, name: string, now = nowIso()): { id: string; name: string } {
  const n = cleanName(name);
  return db.transaction(() => {
    const had = tagByName(db, n);
    if (had) return had;
    const t = { id: uuidv7(), name: n };
    db.prepare('INSERT INTO tag (id, name, created_at) VALUES (?,?,?)').run(t.id, t.name, now);
    audit(db, 'tag', t.id, 'insert', null, t, now);
    return t;
  })();
}

export function renameTag(db: DB, id: string, name: string): { id: string; name: string } {
  const n = cleanName(name);
  return db.transaction(() => {
    const old = tagById(db, id);
    const clash = tagByName(db, n);
    if (clash && clash.id !== id) throw new DomainError(`there is already a tag called "${clash.name}"`, 409);
    db.prepare('UPDATE tag SET name = ? WHERE id = ?').run(n, id);
    audit(db, 'tag', id, 'update', old, { name: n });
    return { id, name: n };
  })();
}

/** Deletes a tag and takes it off every lead. Routine steps filtering by it then match no one. */
export function deleteTag(db: DB, id: string): { removed_from: number } {
  return db.transaction(() => {
    const old = tagById(db, id);
    const n = db.prepare('DELETE FROM lead_tag WHERE tag_id = ?').run(id).changes;
    db.prepare('DELETE FROM tag WHERE id = ?').run(id);
    audit(db, 'tag', id, 'delete', { ...old, leads: n }, null);
    return { removed_from: n };
  })();
}

/** A lead's tags, by name. */
export function leadTags(db: DB, leadId: string): { id: string; name: string }[] {
  return db
    .prepare('SELECT t.id, t.name FROM lead_tag x JOIN tag t ON t.id = x.tag_id WHERE x.lead_id = ? ORDER BY t.name COLLATE NOCASE')
    .all(leadId) as { id: string; name: string }[];
}

/** Puts a tag on (or takes it off) these leads. Returns how many changed; leads that already were are skipped. */
export function setTagOnLeads(db: DB, leadIds: string[], tagId: string, on: boolean, now = nowIso()): number {
  const t = tagById(db, tagId);
  const add = db.prepare('INSERT OR IGNORE INTO lead_tag (lead_id, tag_id, added_at) VALUES (?,?,?)');
  const del = db.prepare('DELETE FROM lead_tag WHERE lead_id = ? AND tag_id = ?');
  const exists = db.prepare('SELECT 1 FROM lead WHERE id = ?');
  const change = db.prepare('INSERT INTO lead_change (id, lead_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?)');
  return db.transaction(() => {
    let changed = 0;
    for (const id of leadIds) {
      if (!exists.get(id)) throw new DomainError('lead not found', 404);
      const n = on ? add.run(id, tagId, now).changes : del.run(id, tagId).changes;
      if (!n) continue;
      change.run(uuidv7(), id, 'tag', on ? null : t.name, on ? t.name : null, now);
      changed++;
    }
    return changed;
  })();
}

/** Tags one lead by tag name, making the tag if it's new. */
export function tagLead(db: DB, leadId: string, name: string): { id: string; name: string }[] {
  return db.transaction(() => {
    setTagOnLeads(db, [leadId], ensureTag(db, name).id, true);
    return leadTags(db, leadId);
  })();
}

/** Puts a tag on (or takes it off) every lead matching the Leads page filters. */
export function setTagForMatching(db: DB, f: LeadFilter, name: string, on: boolean): { changed: number; matched: number; tag: { id: string; name: string } } {
  return db.transaction(() => {
    const tag = on ? ensureTag(db, name) : tagByName(db, cleanName(name));
    if (!tag) throw new DomainError(`there is no tag called "${name.trim()}"`, 404);
    const ids = matchingLeadIds(db, f);
    return { changed: setTagOnLeads(db, ids, tag.id, on), matched: ids.length, tag };
  })();
}
