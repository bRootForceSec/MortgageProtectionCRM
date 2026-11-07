import type { DB } from '../db/connection.js';
import { nowIso, uuidv7 } from '../ids.js';
import { DomainError } from '../core/errors.js';
import { audit } from '../core/audit.js';
import { matchingLeadIds, type LeadFilter } from './callList.js';
import { BY_YOU, type EventBy } from '../../shared/leadEvents.js';

// Tags: your own labels on leads. A lead has any number. Each one put on or taken off a lead is a line in the lead's
// log (lead_event), with what did it; lead_tag is the tags a lead has now. Making, renaming and deleting tags go in
// the audit log.

export interface Tag {
  id: string;
  name: string;
  /** How many leads have it. */
  leads: number;
  /** A lead with it is never dialed: left off the call list unless you add it anyway (Automation → Tags). */
  never_dial: boolean;
}

export function listTags(db: DB): Tag[] {
  return (db
    .prepare('SELECT t.id, t.name, t.never_dial, (SELECT COUNT(*) FROM lead_tag x WHERE x.tag_id = t.id) leads FROM tag t ORDER BY t.name COLLATE NOCASE')
    .all() as (Omit<Tag, 'never_dial'> & { never_dial: number })[]).map((t) => ({ ...t, never_dial: t.never_dial === 1 }));
}

/** Marks a tag "never dial", or takes that off. */
export function setNeverDial(db: DB, id: string, on: boolean): Tag {
  return db.transaction(() => {
    const old = tagById(db, id);
    db.prepare('UPDATE tag SET never_dial = ? WHERE id = ?').run(on ? 1 : 0, id);
    audit(db, 'tag', id, 'update', old, { never_dial: on });
    return listTags(db).find((t) => t.id === id)!;
  })();
}

/** Why a lead must not be dialed: its first never-dial tag (by name), when it was put on and what did it. */
export interface NeverDial { tag: string; at: string | null; source: string | null; source_name: string | null }

/** The never-dial tag on each of these leads that has one. */
export function neverDialOf(db: DB, leadIds: string[]): Map<string, NeverDial> {
  if (!leadIds.length) return new Map();
  const rows = db.prepare(
    `SELECT x.lead_id, t.name tag, e.at, e.source, e.source_name
     FROM lead_tag x JOIN tag t ON t.id = x.tag_id AND t.never_dial = 1
     LEFT JOIN lead_event e ON e.id = (SELECT e2.id FROM lead_event e2 WHERE e2.lead_id = x.lead_id AND e2.tag_id = x.tag_id AND e2.kind = 'tag_added' ORDER BY e2.at DESC, e2.id DESC LIMIT 1)
     WHERE x.lead_id IN (SELECT value FROM json_each(?))
     ORDER BY t.name COLLATE NOCASE`,
  ).all(JSON.stringify(leadIds)) as ({ lead_id: string } & NeverDial)[];
  const out = new Map<string, NeverDial>();
  for (const { lead_id, ...r } of rows) if (!out.has(lead_id)) out.set(lead_id, r);
  return out;
}

/** Notes on the lead that you dialed it past its never-dial tag. False when it has none (nothing to note). */
export function dialedAnyway(db: DB, leadId: string, now = nowIso()): boolean {
  const n = neverDialOf(db, [leadId]).get(leadId);
  if (!n) return false;
  logNeverDialOverride(db, leadId, n.tag, 'dialed anyway', now);
  return true;
}

/** Logs that you went past a never-dial tag: added the lead to the call list anyway, or dialed it anyway. */
export function logNeverDialOverride(db: DB, leadId: string, tag: string, what: 'added anyway' | 'dialed anyway', now = nowIso()) {
  db.prepare('INSERT INTO lead_event (id, lead_id, at, kind, tag_name, source, source_name) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv7(), leadId, now, 'never_dial_override', tag, 'you', what);
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new DomainError('give the tag a name');
  if (n.length > 40) throw new DomainError('keep the tag name under 40 characters');
  return n;
}

/** The tag with this name (any case), if there is one. */
export function tagByName(db: DB, name: string): { id: string; name: string } | undefined {
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

/** Deletes a tag and takes it off every lead (logged). Routine steps filtering by it then match no one. */
export function deleteTag(db: DB, id: string, now = nowIso()): { removed_from: number } {
  return db.transaction(() => {
    const old = tagById(db, id);
    const leads = (db.prepare('SELECT lead_id FROM lead_tag WHERE tag_id = ?').all(id) as { lead_id: string }[]).map((r) => r.lead_id);
    const n = setTagOnLeads(db, leads, id, false, now);
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

/**
 * Puts a tag on (or takes it off) these leads, logging each change with what did it (`by`). Returns how many changed;
 * leads that already were are skipped.
 */
export function setTagOnLeads(db: DB, leadIds: string[], tagId: string, on: boolean, now = nowIso(), by: EventBy = BY_YOU): number {
  const t = tagById(db, tagId);
  const add = db.prepare('INSERT OR IGNORE INTO lead_tag (lead_id, tag_id, added_at) VALUES (?,?,?)');
  const del = db.prepare('DELETE FROM lead_tag WHERE lead_id = ? AND tag_id = ?');
  const exists = db.prepare('SELECT 1 FROM lead WHERE id = ?');
  const log = db.prepare(
    'INSERT INTO lead_event (id, lead_id, at, kind, tag_id, tag_name, source, source_id, source_name, call_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  return db.transaction(() => {
    let changed = 0;
    for (const id of leadIds) {
      if (!exists.get(id)) throw new DomainError('lead not found', 404);
      const n = on ? add.run(id, tagId, now).changes : del.run(id, tagId).changes;
      if (!n) continue;
      log.run(uuidv7(), id, now, on ? 'tag_added' : 'tag_removed', tagId, t.name, by.source, by.id ?? null, by.name ?? null, by.call_id ?? null);
      changed++;
    }
    return changed;
  })();
}

/** A lead's log, newest first: each tag put on or taken off, when, and what did it. */
export function leadEvents(db: DB, leadId: string) {
  return db
    .prepare('SELECT id, at, kind, tag_name, source, source_name FROM lead_event WHERE lead_id = ? ORDER BY at DESC, id DESC')
    .all(leadId) as { id: string; at: string; kind: string; tag_name: string | null; source: string; source_name: string | null }[];
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
