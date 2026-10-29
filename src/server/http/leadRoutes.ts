import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import * as z from 'zod/v4';
import type { DB } from '../db/connection.js';
import type { Config } from '../config.js';
import { DomainError } from '../core/errors.js';
import { logManualCall, changeOutcome, addLeadAction, addNote, callHistory, changeCallerId } from '../domain/calls.js';
import { listLeads, getLeadDetail, leadPdfPage, setLinkStatus } from '../domain/leads.js';
import { parseList } from '../domain/groupFilter.js';
import { setLeadTypeForMatching } from '../domain/leadEdit.js';
import { batchPdf, turnPdfPages, normTurn } from '../domain/pageTurn.js';
import type { PageChecker } from '../domain/pageTurnFix.js';
import {
  addMatchingToCallList, addToCallList, clearWorked, getCallList, moveToBottom,
  recentOutcomes, removeFromCallList, type LeadFilter, callListName, listSavedLists, clearCallList, loadSavedList, deleteSavedList, setCalledBack,
} from '../domain/callList.js';
import { LEAD_FILTERS } from '../../shared/leadStatus.js';

// Leads, the call list, logging calls, and call history.

export function registerLeadRoutes(app: FastifyInstance, deps: { db: DB; config: Config; pageChecker: PageChecker }) {
  const { db, config, pageChecker } = deps;

  // ---------- leads ----------
  const leadFilter = z.object({
    status: z.enum(LEAD_FILTERS).default('all'),
    search: z.string().max(100).optional(),
    batch_id: z.string().max(64).optional(),
    bulk_id: z.string().max(64).optional(),
    counties: z.string().max(4000).optional(),
    area_codes: z.string().max(400).optional(),
    tried_before: z.string().max(40).optional(),
    tried_after: z.string().max(40).optional(),
    not_on_list: z.union([z.boolean(), z.enum(['1', '0', 'true', 'false'])]).optional(),
    /** A lead type code, or "none" for leads with no type. */
    lead_type: z.string().max(20).optional(),
  });
  const toFilter = (q: z.infer<typeof leadFilter>): LeadFilter => ({
    status: q.status,
    search: q.search,
    batch_id: q.batch_id || undefined,
    bulk_id: q.bulk_id || undefined,
    counties: parseList(q.counties),
    areaCodes: parseList(q.area_codes),
    tried_before: q.tried_before || undefined,
    tried_after: q.tried_after || undefined,
    not_on_list: q.not_on_list === true || q.not_on_list === '1' || q.not_on_list === 'true',
    lead_type: !q.lead_type ? undefined : q.lead_type === 'none' ? '' : q.lead_type,
  });

  app.get('/api/leads', async (req) => listLeads(db, toFilter(leadFilter.parse(req.query))));
  // Fixes the lead type after import: every lead matching the filters (e.g. one batch) gets the new type and its price.
  app.post('/api/leads/set-type', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { set_type } = z.object({ set_type: z.string().min(1).max(20).regex(/^[A-Za-z0-9-]+$/).nullable() }).parse(body);
    return setLeadTypeForMatching(db, toFilter(leadFilter.parse(body)), set_type);
  });

  // ---------- the call list ----------
  const savedName = z.string().trim().max(120);
  app.get('/api/call-list', async () => ({
    items: getCallList(db), recent: recentOutcomes(db), name: callListName(db), saved_lists: listSavedLists(db),
  }));
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
    const f = toFilter(leadFilter.parse(body));
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
      callback_due_at: z.string().max(40).nullish(),
      callback_any_time: z.boolean().nullish(),
      do_not_call: z.boolean().nullish(),
      note: z.string().max(10000).nullish(),
      objections: z.array(z.object({ code: z.string().max(40), note: z.string().max(2000).nullish() })).max(20).nullish(),
    }).parse(req.body);
    return logManualCall(db, { ...b, lead_id: id });
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
    return changeOutcome(db, id, b);
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
