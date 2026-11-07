import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import { DomainError } from '../core/errors.js';
import { logManualCall, changeOutcome, addLeadAction, addNote, callHistory, changeCallerId } from '../domain/calls.js';
import { runCallRules, runEventRules } from '../domain/rules.js';
import { leadExists, listLeads, getLeadDetail, leadPdfPage, setLinkStatus } from '../domain/leads.js';
import { parseList } from '../domain/groupFilter.js';
import { setLeadTypeForMatching } from '../domain/leadEdit.js';
import { createCustomField, deleteCustomField, listCustomFields, moveCustomField, updateCustomField } from '../domain/customFields.js';
import { CustomFieldInput } from '../../shared/customFields.js';
import { checkCondition, previewFormula } from '../domain/formulas.js';
import { listStatuses, saveStatuses } from '../domain/statuses.js';
import type { GoogleCalendar } from '../domain/googleCalendar.js';
import { deleteTag, ensureTag, listTags, renameTag, setTagForMatching, setTagOnLeads, tagLead, leadTags } from '../domain/tags.js';
import { batchPdf, turnPdfPages, normTurn } from '../domain/pageTurn.js';
import type { PageChecker } from '../domain/pageTurnFix.js';
import {
  addMatchingToCallList, addToCallList, clearWorked, getCallList, moveToBottom,
  recentOutcomes, removeFromCallList, toLeadFilter, callListMeta, listSavedLists, clearCallList, loadSavedList, deleteSavedList, saveCallList, saveCallListAs, setCalledBack,
} from '../domain/callList.js';
import { LeadPaging, LeadQuery } from '../../shared/leadFilter.js';
import { bestTimes } from '../domain/reports.js';
import { isLeadId } from '../../shared/leadLink.js';

// Leads, the call list, logging calls, and call history.

export function registerLeadRoutes(
  app: FastifyInstance,
  deps: { db: DB; config: Config; pageChecker: PageChecker; openLead?: (leadId: string) => void; calendar: GoogleCalendar },
) {
  const { db, config, pageChecker, calendar } = deps;

  // ---------- lead links ----------
  // A link pasted into an appointment (shared/leadLink.ts). It's clicked in any browser, so it needs no cookie, and
  // the page it shows says nothing about the lead. The desktop app brings its window up on the lead; in a browser
  // (the Linux service) it goes on to the app, which opens the lead from #lead/<id>.
  app.get('/lead/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().refine(isLeadId, 'not a lead link') }).parse(req.params);
    if (!leadExists(db, id)) throw new DomainError('That lead is not in the CRM on this computer.', 404);
    if (!deps.openLead) return reply.redirect(`/#lead/${id}`, 303);
    deps.openLead(id);
    return reply
      .type('text/html; charset=utf-8')
      .send('<!doctype html><meta charset="utf-8"><title>Opened in the CRM</title><p style="font:16px system-ui;margin:2em">Opened in Mortgage Protection CRM. You can close this tab.</p>');
  });

  // ---------- leads ----------
  app.get('/api/leads', async (req) => listLeads(db, toLeadFilter(LeadQuery.parse(req.query)), LeadPaging.parse(req.query)));
  // Fixes the lead type after import: every lead matching the filters (e.g. one batch) gets the new type and its price.
  app.post('/api/leads/set-type', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { set_type } = z.object({ set_type: z.string().min(1).max(20).regex(/^[A-Za-z0-9-]+$/).nullable() }).parse(body);
    return setLeadTypeForMatching(db, toLeadFilter(LeadQuery.parse(body)), set_type);
  });

  // ---------- tags ----------
  const tagName = z.string().max(80);
  app.get('/api/tags', async () => listTags(db));
  app.post('/api/tags', async (req) => ensureTag(db, z.object({ name: tagName }).parse(req.body).name));
  app.put('/api/tags/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    return renameTag(db, id, z.object({ name: tagName }).parse(req.body).name);
  });
  app.delete('/api/tags/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    return deleteTag(db, id);
  });
  app.post('/api/leads/:id/tags', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    tagLead(db, id, z.object({ name: tagName }).parse(req.body).name);
    // Rules on that tag run first, so the lead's tags come back with what they did.
    runEventRules(db);
    return leadTags(db, id);
  });
  app.delete('/api/leads/:id/tags/:tagId', async (req) => {
    const { id, tagId } = z.object({ id: z.string().max(64), tagId: z.string().max(64) }).parse(req.params);
    setTagOnLeads(db, [id], tagId, false);
    runEventRules(db);
    return leadTags(db, id);
  });
  // Puts a tag on (or takes it off) every lead matching the filters.
  app.post('/api/leads/tag-matching', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const b = z.object({ tag_name: tagName, remove: z.boolean().optional() }).parse(body);
    return setTagForMatching(db, toLeadFilter(LeadQuery.parse(body)), b.tag_name, !b.remove);
  });

  // ---------- custom fields (values are saved with the lead's other edits: PATCH /api/leads/:id) ----------
  const fieldId = z.object({ id: z.string().max(64) });
  app.get('/api/custom-fields', async () => listCustomFields(db));
  app.post('/api/custom-fields', async (req) => createCustomField(db, CustomFieldInput.parse(req.body)));
  app.put('/api/custom-fields/:id', async (req) => updateCustomField(db, fieldId.parse(req.params).id, CustomFieldInput.parse(req.body)));
  app.post('/api/custom-fields/:id/move', async (req) => {
    const { by } = z.object({ by: z.union([z.literal(-1), z.literal(1)]) }).parse(req.body);
    return moveCustomField(db, fieldId.parse(req.params).id, by);
  });
  app.delete('/api/custom-fields/:id', async (req) => deleteCustomField(db, fieldId.parse(req.params).id));
  app.post('/api/custom-fields/formula-preview', async (req) => {
    const b = z.object({ formula: z.string().max(2000), field_id: z.string().max(64).nullish() }).parse(req.body);
    return previewFormula(db, b.formula, b.field_id ?? null);
  });
  app.get('/api/statuses', async () => listStatuses(db));
  app.put('/api/statuses', async (req) => saveStatuses(db, req.body));
  app.post('/api/conditions/check', async (req) => checkCondition(db, z.object({ condition: z.string().max(2000) }).parse(req.body).condition));

  // ---------- the call list ----------
  const savedName = z.string().trim().max(120);
  app.get('/api/call-list', async (req) => {
    const { tz } = z.object({ tz: z.string().max(64).optional() }).parse(req.query);
    return {
      items: getCallList(db), recent: recentOutcomes(db), ...callListMeta(db), saved_lists: listSavedLists(db),
      best_times: bestTimes(db, tz || Intl.DateTimeFormat().resolvedOptions().timeZone),
    };
  });
  // `replace` empties the list first (kept as a saved list named `save_current_as`, if given).
  const replaceOpts = z.object({ replace: z.boolean().optional(), save_current_as: savedName.nullish() });
  app.post('/api/call-list', async (req) => {
    const b = z.object({ lead_ids: z.array(z.string().max(64)).max(20_000) }).extend(replaceOpts.shape).parse(req.body);
    return db.transaction(() => {
      if (b.replace) clearCallList(db, b.save_current_as);
      return addToCallList(db, b.lead_ids);
    })();
  });
  app.post('/api/call-list/add-matching', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const o = replaceOpts.parse({ replace: body.replace, save_current_as: body.save_current_as });
    const f = toLeadFilter(LeadQuery.parse(body));
    return db.transaction(() => {
      if (o.replace) clearCallList(db, o.save_current_as);
      return addMatchingToCallList(db, f);
    })();
  });
  app.post('/api/call-list/clear-worked', async () => ({ removed: clearWorked(db) }));
  app.post('/api/call-list/clear', async (req) => {
    const b = z.object({ save_as: savedName.nullish() }).parse(req.body ?? {});
    return clearCallList(db, b.save_as);
  });
  // Save writes over the saved list the call list is; Save as makes one (or writes over the one with that name).
  app.post('/api/call-list/save', async () => ({ saved: saveCallList(db) }));
  app.post('/api/call-list/save-as', async (req) => {
    const b = z.object({ name: savedName.min(1, 'give the list a name') }).parse(req.body);
    const saved = saveCallListAs(db, b.name);
    if (!saved) throw new DomainError('the call list is empty', 409);
    return { saved };
  });
  app.post('/api/saved-lists/:id/load', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ save_current_as: savedName.nullish() }).parse(req.body ?? {});
    const r = loadSavedList(db, id, b.save_current_as);
    if (!r) throw new DomainError('that saved list is gone', 404);
    return r;
  });
  app.delete('/api/saved-lists/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    deleteSavedList(db, id);
    return { ok: true };
  });
  app.post('/api/call-list/:leadId/skip', async (req) => {
    const { leadId } = z.object({ leadId: z.string().max(64) }).parse(req.params);
    if (!moveToBottom(db, leadId)) throw new DomainError('that lead is not on the call list', 404);
    return { ok: true };
  });
  app.delete('/api/call-list/:leadId', async (req) => {
    const { leadId } = z.object({ leadId: z.string().max(64) }).parse(req.params);
    removeFromCallList(db, leadId);
    return { ok: true };
  });

  // The PDF a batch was imported from (kept as "<batch id>-<file name>" in the imports folder).
  app.get('/api/batches/:id/file', async (req, reply) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const file = batchPdf(config.importsDir, id);
    if (!file) throw new DomainError('the PDF for this batch is not on this computer', 404);
    return reply.type('application/pdf').send(fs.createReadStream(file));
  });

  // "Check all lead pages": goes through every imported PDF and turns sideways or upside-down pages upright.
  app.get('/api/lead-pages/check', async () => pageChecker.state);
  app.post('/api/lead-pages/check', async () => {
    void pageChecker.start(true);
    return pageChecker.state;
  });

  // Saves a turn of the lead's page in the batch PDF, so it shows the right way up from now on.
  app.post('/api/leads/:id/page-turn', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const { turn } = z.object({ turn: z.number().int() }).parse(req.body);
    const { file, page } = leadPdfPage(db, config.importsDir, id);
    const turned = await turnPdfPages(file, new Map([[page, normTurn(turn)]]));
    return { ok: true, turned };
  });

  app.get('/api/leads/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    return getLeadDetail(db, config.importsDir, id);
  });

  app.post('/api/leads/:id/calls', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({
      idempotency_key: z.string().min(8).max(100),
      from_number_id: z.string().max(64).nullish(),
      occurred_at: z.string().max(40).nullish(),
      talk_seconds: z.number().min(0).max(36000).nullish(),
      dial_count: z.number().int().min(1).max(1000).nullish(),
      lead_seconds: z.number().min(0).max(7 * 86400).nullish(),
      dialed_at: z.string().max(40).nullish(),
      outcome_code: z.string().max(40),
      button_id: z.string().max(64).nullish(),
      fields: z.record(z.string().max(64), z.string().max(2000).nullable()).nullish(),
      callback_due_at: z.string().max(40).nullish(),
      callback_any_time: z.boolean().nullish(),
      do_not_call: z.boolean().nullish(),
      note: z.string().max(10000).nullish(),
      appointment_for: z.string().max(20).nullish(),
      on_the_spot: z.boolean().nullish(),
      objections: z.array(z.object({ code: z.string().max(40), note: z.string().max(2000).nullish() })).max(20).nullish(),
    }).parse(req.body);
    const r = logManualCall(db, { ...b, lead_id: id });
    // Rules for this outcome run after the call is saved; one that fails is in the rules log, never the call's error.
    if (!r.duplicate) runCallRules(db, r.call_id);
    // An appointment set (or undone) shows on Google Calendar soon.
    calendar.kick();
    return r;
  });

  app.post('/api/calls/:id/outcomes', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({
      outcome_code: z.string().max(40),
      expected_current_id: z.string().max(64).nullable(),
      callback_due_at: z.string().max(40).nullish(),
      callback_any_time: z.boolean().nullish(),
      do_not_call: z.boolean().nullish(),
      note: z.string().max(10000).nullish(),
    }).parse(req.body);
    const r = changeOutcome(db, id, b);
    runCallRules(db, id);
    calendar.kick();
    return r;
  });

  app.post('/api/leads/:id/actions', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ action: z.enum(['skip', 'mark_dead', 'restore']), reason: z.string().max(500).nullish() }).parse(req.body);
    return addLeadAction(db, id, b.action, b.reason);
  });

  app.post('/api/leads/:id/called-back', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ on: z.boolean() }).parse(req.body);
    return { called_back_at: setCalledBack(db, id, b.on) };
  });

  app.post('/api/leads/:id/notes', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ body: z.string().max(10000), call_id: z.string().max(64).nullish() }).parse(req.body);
    return addNote(db, id, b.body, b.call_id);
  });

  app.post('/api/lead-links/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(64) }).parse(req.params);
    const b = z.object({ status: z.enum(['suggested', 'same_person', 'different_person']) }).parse(req.body);
    setLinkStatus(db, id, b.status);
    return { ok: true };
  });

  // ---------- call history ----------
  app.get('/api/calls', async (req) => {
    const q = z.object({
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      outcome: z.string().max(40).optional(),
      search: z.string().max(100).optional(),
      counties: z.string().max(4000).optional(),
      area_codes: z.string().max(400).optional(),
      from_number: z.string().max(64).optional(),
    }).parse(req.query);
    return callHistory(db, { ...q, counties: parseList(q.counties), areaCodes: parseList(q.area_codes), fromNumber: q.from_number });
  });

  // Fix the caller ID on many calls at once (null: no caller ID recorded).
  app.post('/api/calls/caller-id', async (req) => {
    const b = z.object({
      call_ids: z.array(z.string().max(64)).min(1).max(5000),
      from_number_id: z.string().max(64).nullable(),
    }).parse(req.body);
    return changeCallerId(db, b.call_ids, b.from_number_id);
  });
}
