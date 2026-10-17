import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultWhen } from '../when';
import { api, fmtMoney, fmtPhone, fmtRelative, newKey, toLocalInput, type LeadDetail, type QueueResponse, type QueueItem } from '../api';
import { useApp } from '../App';
import { LeadSummary, CallHistory, Notes } from '../components/LeadView';
import { EditLead } from '../components/EditLead';
import { DialQr } from '../components/DialQr';
import { GroupPicker, useGroups } from '../components/GroupPicker';
import { fillScript, isAction, isTyping, keyLabel, normKey, type KeyMap } from '../shortcuts';

const BUCKETS: { key: QueueItem['bucket'] | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'callback_due', label: 'Callbacks due' },
  { key: 'new', label: 'New' },
  { key: 'retry', label: 'Retry' },
];

const SELECTED_KEY = 'mpcrm.selectedLead';
const LIST_KEY = 'mpcrm.worklist';
const LAST_NUMBER_KEY = 'mpcrm.lastNumber';

function store(k: string, v?: string | null) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: selection just won't persist */
  }
  return null;
}

const SCRIPT_KEY = 'mpcrm.script.open';
const UNDO_MS = 10_000;

/** One attempt on the current lead: how many dials, when the timer started, which number was dialed. */
interface Attempt {
  dials: number;
  timerStart: number | null;
  to: string | null;
}
const freshAttempt = (): Attempt => ({ dials: 1, timerStart: null, to: null });

/** What you had entered, put back after an undo. */
interface FormValues {
  code: string | null;
  when: string;
  minutes: string;
  note: string;
  numberId: string | null;
}

interface Saved {
  callId: string;
  leadId: string;
  name: string;
  label: string;
  dials: number;
  at: number;
}

/**
 * Your working list: the queue as it was when you started (or last refreshed), in a fixed order.
 * Worked leads stay in it, greyed out, so you see the list go down as you go.
 */
interface WorkItem extends QueueItem {
  done?: { label: string; dials: number } | null;
  /** A callback that came due while you were calling, added to the top. */
  due_now?: boolean;
}
interface WorkList {
  key: string;
  items: WorkItem[];
  built_at: string;
}

function loadList(key: string): WorkList | null {
  try {
    const l = JSON.parse(store(LIST_KEY) ?? 'null') as WorkList | null;
    return l && l.key === key && Array.isArray(l.items) ? l : null;
  } catch {
    return null;
  }
}

export function CallingPage() {
  const { toast, keys, calling, bumpStats } = useApp();
  const settings = calling?.settings;
  const [bucket, setBucket] = useState<QueueItem['bucket'] | 'all'>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [counts, setCounts] = useState<QueueResponse['counts'] | null>(null);
  const [waitingLater, setWaitingLater] = useState(0);
  /** Leads in the queue that aren't in your list yet (new imports, retries come due). */
  const [more, setMore] = useState(0);
  const [groups, setGroups, groupParams] = useGroups();
  const listKey = JSON.stringify({ bucket, search: debounced, ...groupParams });
  const [list, setListState] = useState<WorkList | null>(() => loadList(listKey));
  const [selected, setSelected] = useState<string | null>(store(SELECTED_KEY));
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [attempt, setAttempt] = useState<Attempt>(freshAttempt);
  const [restore, setRestore] = useState<{ leadId: string; values: FormValues; n: number } | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [showScript, setShowScript] = useState(store(SCRIPT_KEY) === '1');
  const [editing, setEditing] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const setList = useCallback((l: WorkList | null) => {
    setListState(l);
    store(LIST_KEY, l ? JSON.stringify(l) : null);
  }, []);
  const updateList = useCallback((f: (items: WorkItem[]) => WorkItem[]) => {
    setListState((l) => {
      if (!l) return l;
      const next = { ...l, items: f(l.items) };
      store(LIST_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const select = (id: string | null) => {
    setSelected(id);
    store(SELECTED_KEY, id);
  };

  const fetchQueue = useCallback(async () => {
    try {
      const q = await api.get<QueueResponse>('/queue', {
        bucket: bucket === 'all' ? undefined : bucket,
        search: debounced,
        limit: '2000',
        ...groupParams,
      });
      setCounts(q.counts);
      setWaitingLater(q.waiting_later);
      return q;
    } catch (e: any) {
      toast(e.message, 'error');
      return null;
    }
  }, [bucket, debounced, groupParams.counties, groupParams.area_codes, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Builds a fresh working list from the queue. Worked leads drop out; leads due again come in. */
  const rebuild = useCallback(async () => {
    const q = await fetchQueue();
    if (!q) return;
    const l: WorkList = { key: listKey, items: q.items, built_at: new Date().toISOString() };
    setList(l);
    setMore(0);
    const keep = selected && l.items.some((i) => i.lead_id === selected);
    if (!keep) select(l.items[0]?.lead_id ?? null);
  }, [fetchQueue, listKey, selected, setList]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Adds callbacks that came due since the list was built, at the top. */
  const mergeDue = useCallback(async () => {
    const q = await fetchQueue();
    if (!q) return;
    updateList((items) => {
      const have = new Set(items.map((i) => i.lead_id));
      const due = q.items.filter((i) => i.bucket === 'callback_due' && !have.has(i.lead_id));
      setMore(q.items.filter((i) => !have.has(i.lead_id) && !due.includes(i)).length);
      return due.length ? [...due.map((i) => ({ ...i, due_now: true })), ...items] : items;
    });
  }, [fetchQueue, updateList]);

  // A new filter, tab or search makes a new list; the same one is kept across page changes and refreshes.
  useEffect(() => {
    const stored = loadList(listKey);
    // A list with nothing left to call is rebuilt, so new imports show up without a refresh.
    if (stored && stored.items.some((i) => !i.done)) {
      setListState(stored);
      void mergeDue();
    } else void rebuild();
  }, [listKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setInterval(() => void mergeDue(), 60_000);
    return () => clearInterval(t);
  }, [mergeDue]);

  const loadDetail = useCallback(async (id: string | null) => {
    if (!id) return setDetail(null);
    try {
      setDetail(await api.get<LeadDetail>(`/leads/${id}`));
    } catch {
      setDetail(null);
      setSelected(null);
      store(SELECTED_KEY, null);
    }
  }, []);
  useEffect(() => void loadDetail(selected), [selected, loadDetail]);

  // A new lead starts a new attempt, unless an undo is putting the last one back.
  useEffect(() => {
    if (restore && restore.leadId === selected) return;
    setRestore(null);
    setAttempt(freshAttempt());
    // Keep the selected lead in view as you move with the arrow keys.
    listRef.current?.querySelector(`[data-lead="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened from the Today page or a callback alert.
  useEffect(() => {
    const f = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      select(id);
      void mergeDue();
    };
    window.addEventListener('mpcrm:open-lead', f);
    return () => window.removeEventListener('mpcrm:open-lead', f);
  }, [mergeDue]);

  const items = list?.items ?? [];
  // Nothing selected yet (first visit, or the lead left the list): start at the top.
  useEffect(() => {
    if (list && (!selected || !list.items.some((i) => i.lead_id === selected)) && !detail) {
      const first = list.items.find((i) => !i.done) ?? list.items[0];
      if (first) select(first.lead_id);
    }
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const idx = items.findIndex((i) => i.lead_id === selected);
  const left = items.filter((i) => !i.done).length;

  /** The next lead you haven't worked yet, below the current one first. */
  const nextUnworked = useCallback(
    (from = idx) => {
      const after = items.slice(from + 1).find((i) => !i.done);
      return after ?? items.slice(0, Math.max(0, from)).find((i) => !i.done) ?? null;
    },
    [items, idx],
  );

  const goNext = useCallback(() => {
    const n = nextUnworked();
    if (n) select(n.lead_id);
    else toast('You\'ve worked the whole list. Press "Refresh list" to load more.');
  }, [nextUnworked, toast]);

  const move = useCallback(
    (step: 1 | -1) => {
      if (!items.length) return;
      const i = idx < 0 ? 0 : Math.min(items.length - 1, Math.max(0, idx + step));
      select(items[i]!.lead_id);
    },
    [items, idx],
  );

  const markDone = (leadId: string, done: WorkItem['done']) =>
    updateList((xs) => xs.map((i) => (i.lead_id === leadId ? { ...i, done, due_now: false } : i)));

  const skip = useCallback(async () => {
    if (!selected) return;
    await api.post(`/leads/${selected}/actions`, { action: 'skip' });
    markDone(selected, { label: 'Skipped', dials: 0 });
    goNext();
  }, [selected, goNext]); // eslint-disable-line react-hooks/exhaustive-deps

  const dial = useCallback(
    async (e164: string | null | undefined) => {
      if (!e164) return;
      const method = settings?.dial_method ?? 'copy';
      setAttempt((a) => ({ ...a, to: e164, timerStart: a.timerStart ?? (settings?.use_timer === false ? null : Date.now()) }));
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(e164.replace(/^\+1/, ''));
          toast(`Copied ${fmtPhone(e164)}`);
        } catch {
          toast('Could not copy; select the number instead', 'error');
        }
      };
      if (method === 'qr') return setQr(e164);
      if (method === 'kdeconnect') {
        try {
          await api.post('/dial', { to_e164: e164 });
          toast(`Sent ${fmtPhone(e164)} to your phone`);
        } catch (e: any) {
          toast(`${e.message}. The number was copied instead.`, 'error');
          await copy();
        }
        return;
      }
      await copy();
    },
    [settings, toast],
  );

  /** Takes back the last saved call: back to that lead, outcome removed, your entries put back to fix. */
  const undo = useCallback(async () => {
    if (!saved || Date.now() - saved.at > UNDO_MS) return;
    const s = saved;
    setSaved(null);
    try {
      const r = await api.post<{
        lead_id: string; outcome_code: string | null; callback_due_at: string | null;
        dial_count: number; talk_seconds: number | null; from_number_id: string | null; note: string | null;
      }>(`/calls/${s.callId}/void`, { reason: 'undo' });
      const when = r.callback_due_at;
      setRestore({
        leadId: s.leadId,
        n: Date.now(),
        values: {
          code: r.outcome_code,
          when: when ? toLocalInput(new Date(when)) : '',
          minutes: r.talk_seconds ? String(Math.round(r.talk_seconds / 60)) : '',
          note: r.note ?? '',
          numberId: r.from_number_id,
        },
      });
      setAttempt({ dials: r.dial_count, timerStart: null, to: null });
      markDone(s.leadId, null);
      select(s.leadId);
      toast(`Undone. Pick the right outcome for ${s.name} and press Enter.`);
      bumpStats();
      await loadDetail(s.leadId);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [saved, toast, bumpStats, loadDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  const modalOpen = editing || !!qr;
  // Layout effect, so the keys act on the lead you can see as soon as it's on screen.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const act = (a: Parameters<typeof isAction>[1]) => isAction(keys, a, e);
      if (act('list_down')) { e.preventDefault(); move(1); }
      else if (act('list_up')) { e.preventDefault(); move(-1); }
      else if (act('next')) { e.preventDefault(); goNext(); }
      else if (act('skip')) { e.preventDefault(); void skip(); }
      else if (act('search')) { e.preventDefault(); searchRef.current?.focus(); }
      else if (act('note')) { e.preventDefault(); document.getElementById('note-input')?.focus(); }
      else if (act('dial')) { e.preventDefault(); void dial(detail?.lead.phone_e164); }
      else if (act('dials_up')) { e.preventDefault(); setAttempt((a) => ({ ...a, dials: a.dials + 1 })); }
      else if (act('dials_down')) { e.preventDefault(); setAttempt((a) => ({ ...a, dials: Math.max(1, a.dials - 1) })); }
      else if (act('undo')) { e.preventDefault(); void undo(); }
      else if (act('edit')) { if (detail) { e.preventDefault(); setEditing(true); } }
      else if (act('script')) { e.preventDefault(); setShowScript((v) => { store(SCRIPT_KEY, v ? '0' : '1'); return !v; }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys, move, goNext, skip, dial, undo, detail, modalOpen]);

  const refreshDetail = async () => {
    await loadDetail(selected);
  };

  // Enter saves and moves straight on; the undo bar (or Z) brings you back.
  const onSaved = async (s: Saved) => {
    setSaved(s);
    setRestore(null);
    setAttempt(freshAttempt());
    bumpStats();
    markDone(s.leadId, { label: s.label, dials: s.dials });
    const n = items.slice(Math.max(0, items.findIndex((i) => i.lead_id === s.leadId)) + 1).find((i) => !i.done && i.lead_id !== s.leadId)
      ?? items.find((i) => !i.done && i.lead_id !== s.leadId);
    if (n) select(n.lead_id);
    else {
      toast('That was the last lead in your list. Press "Refresh list" to load more.');
      await refreshDetail();
    }
    void mergeDue();
  };

  const gap = settings?.retry_gap_minutes ?? 240;
  const gapText = gap === 0 ? 'right away' : gap % 60 === 0 ? `${gap / 60} h` : `${gap} min`;
  const k = (a: keyof KeyMap['actions']) => keyLabel(keys.actions[a]?.[0] ?? '');
  const dialLabel = settings?.dial_method === 'qr' ? 'Show QR' : settings?.dial_method === 'kdeconnect' ? 'Dial on phone' : 'Copy number';

  return (
    <div className="calling">
      <section className="panel" aria-label="Queue">
        <header>
          <input
            ref={searchRef}
            placeholder={`Search name, county, phone or area code  ( ${k('search')} )`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setSearch(''), (e.target as HTMLInputElement).blur())}
            style={{ width: '100%' }}
            title="A 3-digit number finds every county under that area code"
          />
          <GroupPicker groups={groups} onChange={setGroups} />
          <div className="tabs" title={`Order: due callbacks, new leads (newest batch first), then retries ${gapText} after the last attempt (change this in Settings). Skipped leads drop to the end for today.`}>
            {BUCKETS.map((b) => (
              <button key={b.key} className={bucket === b.key ? 'active' : ''} onClick={() => setBucket(b.key)}>
                {b.label}
                {b.key !== 'all' && counts ? ` ${counts[b.key]}` : ''}
              </button>
            ))}
          </div>
          <div className="row list-head">
            <span><b>{left}</b> to go · {items.length - left} done</span>
            <button className="btn small" onClick={() => void rebuild()} title="Load the queue again: worked leads leave the list, and leads due again come in">
              Refresh list{more > 0 ? ` (+${more})` : ''}
            </button>
          </div>
        </header>
        <div className="body">
          {!list ? null : items.length === 0 ? (
            <div className="empty">
              Nothing to call right now.
              {waitingLater > 0 && <div>{waitingLater} lead(s) are waiting for a later callback or retry time.</div>}
            </div>
          ) : (
            <ul className="queue-list" ref={listRef}>
              {items.map((i) => (
                <li
                  key={i.lead_id}
                  data-lead={i.lead_id}
                  className={`${selected === i.lead_id ? 'selected' : ''} ${i.done ? 'done' : ''} ${i.skipped_today ? 'skipped' : ''}`}
                  onClick={() => select(i.lead_id)}
                >
                  <span className="name">{i.name}</span>
                  {i.done ? (
                    <span className="badge done">{i.done.label}{i.done.dials > 1 ? ` · ${i.done.dials} dials` : ''}</span>
                  ) : (
                    <span className={`badge ${i.bucket}`}>
                      {i.due_now ? 'due now' : i.bucket === 'callback_due' ? (i.needs_time ? 'callback, needs a time' : 'callback') : i.bucket}
                    </span>
                  )}
                  <span className="sub">
                    {fmtPhone(i.phone_e164)} · {i.county ? `${i.county} Co.` : i.state ?? '?'} · {i.attempts_total ? `${i.attempts_total} attempt${i.attempts_total > 1 ? 's' : ''}, last ${fmtRelative(i.last_call_at)}` : 'never called'}
                    {i.skipped_today && !i.done && ' · skipped'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <header style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
          <span className="help">
            <kbd>{k('list_up')}</kbd><kbd>{k('list_down')}</kbd> move <kbd>{k('skip')}</kbd> skip <kbd>{k('search')}</kbd> search <kbd>{k('dial')}</kbd> {dialLabel.toLowerCase()}{' '}
            <kbd>{k('dials_down')}</kbd><kbd>{k('dials_up')}</kbd> dials <kbd>Enter</kbd> save and next <kbd>{k('undo')}</kbd> undo <kbd>{k('note')}</kbd> note{' '}
            <kbd>{k('edit')}</kbd> edit <kbd>{k('script')}</kbd> script
          </span>
        </header>
      </section>

      <section className="panel" aria-label="Current lead">
        <div className="body">
          {saved && <UndoBar saved={saved} undoKey={k('undo')} onUndo={undo} onExpire={() => setSaved(null)} />}
          {!detail ? (
            <div className="empty">Select a lead from the list, or import leads first.</div>
          ) : (
            <>
              <LeadSummary d={detail} onDial={dial} dialLabel={dialLabel} dialKey={k('dial')} onEdit={() => setEditing(true)} editKey={k('edit')} />
              {showScript && <ScriptPanel d={detail} />}
              <LogCall
                key={`${detail.lead.id}-${restore?.leadId === detail.lead.id ? restore.n : 0}`}
                d={detail}
                attempt={attempt}
                setDials={(n) => setAttempt((a) => ({ ...a, dials: Math.max(1, n) }))}
                resetTimer={() => setAttempt((a) => ({ ...a, timerStart: null }))}
                restore={restore?.leadId === detail.lead.id ? restore.values : null}
                onSaved={onSaved}
                onRefresh={refreshDetail}
              />
            </>
          )}
        </div>
      </section>

      <section className="panel" aria-label="History">
        <header><h3>Calls</h3></header>
        <div className="body">
          {detail && <CallHistory calls={detail.calls} onChange={refreshDetail} />}
          <h3 style={{ marginTop: 16 }}>Notes</h3>
          {detail && <Notes d={detail} onChange={refreshDetail} />}
        </div>
      </section>
      {editing && detail && <EditLead d={detail} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await refreshDetail(); }} />}
      {qr && <DialQr e164={qr} onClose={() => setQr(null)} />}
    </div>
  );
}

function UndoBar({ saved, undoKey, onUndo, onExpire }: { saved: Saved; undoKey: string; onUndo: () => void; onExpire: () => void }) {
  const [left, setLeft] = useState(Math.ceil((UNDO_MS - (Date.now() - saved.at)) / 1000));
  useEffect(() => {
    const t = setInterval(() => {
      const l = Math.ceil((UNDO_MS - (Date.now() - saved.at)) / 1000);
      if (l <= 0) onExpire();
      else setLeft(l);
    }, 250);
    return () => clearInterval(t);
  }, [saved, onExpire]);
  return (
    <div className="undo-bar" role="status">
      Saved for {saved.name}: <b>{saved.label}</b>{saved.dials > 1 ? ` · ${saved.dials} dials` : ''}
      <button className="btn small" onClick={onUndo}>Undo <kbd>{undoKey}</kbd></button>
      <span className="muted">{left}s</span>
    </div>
  );
}

/** Your opener and voicemail with this lead's details filled in. */
function ScriptPanel({ d }: { d: LeadDetail }) {
  const { calling, go } = useApp();
  const sc = calling?.settings.scripts;
  const l = d.lead;
  const values = {
    first_name: l.first_name, last_name: l.last_name, full_name: [l.first_name, l.last_name].filter(Boolean).join(' '),
    lender: l.lender, loan_amount: l.loan_amount_cents != null ? fmtMoney(l.loan_amount_cents) : l.loan_amount_raw,
    address: l.address_line, city: l.city, state: l.state, county: l.county, age: l.age != null ? String(l.age) : null,
    agent_name: sc?.agent_name,
  };
  if (!sc?.opener && !sc?.voicemail) {
    return (
      <div className="card script">
        No script yet. <button className="btn small" onClick={() => go('settings')}>Write one in Settings</button>
      </div>
    );
  }
  return (
    <div className="card script">
      {sc.opener && (<><b>Opener</b><p>{fillScript(sc.opener, values)}</p></>)}
      {sc.voicemail && (<><b>Voicemail</b><p>{fillScript(sc.voicemail, values)}</p></>)}
    </div>
  );
}

function Timer({ start, onReset }: { start: number; onReset: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - start) / 1000));
  return (
    <span className="timer" title="Started when you dialed. Fills talk minutes when someone picked up.">
      ⏱ {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
      <button className="btn small" onClick={onReset} aria-label="Reset timer">Reset</button>
    </span>
  );
}

/**
 * Log a call made on another phone (Sideline) with one keypress plus Enter.
 * Phase 2 replaces "log" with "call" but keeps this outcome panel.
 */
function LogCall({
  d, attempt, setDials, resetTimer, restore, onSaved, onRefresh,
}: {
  d: LeadDetail;
  attempt: Attempt;
  setDials: (n: number) => void;
  resetTimer: () => void;
  restore: FormValues | null;
  onSaved: (s: Saved) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const { meta, toast, keys, calling } = useApp();
  const activeNumbers = useMemo(() => (meta?.numbers ?? []).filter((n) => n.status !== 'retired'), [meta]);
  const defaultNumber = useMemo(() => {
    const pref = d.state?.preferred_number_id;
    if (pref && activeNumbers.some((n) => n.id === pref)) {
      return { id: pref, why: d.state?.status === 'appointment_set' ? 'number this appointment was set from' : 'number last used with this lead', known: true };
    }
    const last = store(LAST_NUMBER_KEY);
    if (last && activeNumbers.some((n) => n.id === last)) return { id: last, why: 'your last used number', known: false };
    return { id: activeNumbers[0]?.id ?? '', why: activeNumbers[0] ? 'first active number' : '', known: false };
  }, [d, activeNumbers]);

  const [numberId, setNumberId] = useState(restore?.numberId ?? defaultNumber.id);
  const [code, setCode] = useState<string | null>(restore?.code ?? null);
  const [when, setWhen] = useState(restore?.when ?? '');
  const [minutes, setMinutes] = useState(restore?.minutes ?? '');
  const [note, setNote] = useState(restore?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState(newKey());
  const whenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!numberId && defaultNumber.id) setNumberId(defaultNumber.id);
  }, [defaultNumber.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const outcome = meta?.outcome_codes.find((o) => o.code === code) ?? null;
  const needsWhen = !!outcome?.requires_callback_time;
  const changed = numberId !== defaultNumber.id;

  const choose = useCallback((c: string) => {
    setCode(c);
    const o = meta?.outcome_codes.find((x) => x.code === c);
    if (o?.requires_callback_time) {
      setWhen((w) => w || toLocalInput(defaultWhen(calling?.settings.late_cutoff_hour ?? 21)));
      setTimeout(() => whenRef.current?.focus(), 0);
    }
  }, [meta]);

  // Talk time from the timer, only when someone picked up and you didn't type minutes yourself.
  const timerSeconds = () =>
    attempt.timerStart && outcome?.counts_as_human_contact && calling?.settings.use_timer !== false
      ? Math.round((Date.now() - attempt.timerStart) / 1000)
      : null;

  const save = useCallback(async () => {
    if (!code || saving) return;
    if (code === 'dnc_request' && !window.confirm('Move this lead to the dead pile? It will leave the queue.')) return;
    if (needsWhen && !when) {
      toast('Enter when to call back', 'error');
      whenRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const iso = when ? new Date(when).toISOString() : null;
      const r = await api.post<{ call_id: string }>(`/leads/${d.lead.id}/calls`, {
        idempotency_key: key,
        from_number_id: numberId || null,
        to_e164: attempt.to,
        outcome_code: code,
        callback_due_at: outcome?.requires_callback_time ? iso : null,
        talk_seconds: minutes ? Number(minutes) * 60 : timerSeconds(),
        dial_count: attempt.dials,
        note: note || null,
      });
      if (numberId) store(LAST_NUMBER_KEY, numberId);
      setCode(null);
      setWhen('');
      setMinutes('');
      setNote('');
      setKey(newKey());
      await onSaved({
        callId: r.call_id, leadId: d.lead.id, name: [d.lead.first_name, d.lead.last_name].filter(Boolean).join(' ') || 'this lead',
        label: outcome?.label ?? code, dials: attempt.dials, at: Date.now(),
      });
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }, [code, saving, needsWhen, when, key, numberId, outcome, minutes, note, d.lead.id, toast, onSaved, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Layout effect: the hotkeys are live as soon as the lead is on screen, so a fast keypress isn't lost.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-back')) return;
      if (e.key === 'Enter' && code && (!isTyping(e) || e.ctrlKey || e.metaKey || ['when-input', 'log-note', 'log-minutes'].includes((e.target as HTMLElement).id))) {
        e.preventDefault();
        void save();
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') return setCode(null);
      // Action keys win over outcome keys (Settings warns about clashes).
      if (Object.values(keys.actions).some((ks) => ks.includes(normKey(e.key)))) return;
      const c = keys.outcomes.get(normKey(e.key));
      if (c) {
        e.preventDefault();
        choose(c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys, code, save, choose]);

  if (!d.lead.phone_e164 && !d.lead.phone2_e164 && !d.lead.phone3_e164) return <p className="error">This lead has no valid phone number.</p>;
  if (d.state?.status === 'dead') return <RestoreBox d={d} onSaved={onRefresh} label="This lead is in the dead pile." />;

  const k = (a: keyof KeyMap['actions']) => keyLabel(keys.actions[a]?.[0] ?? '');
  return (
    <div className="log-box">
      <div className="row">
        <div className="dial-counter" aria-label="Dials this attempt">
          <button className="btn small" onClick={() => setDials(attempt.dials - 1)} disabled={attempt.dials <= 1} aria-label="One less dial">− <kbd>{k('dials_down')}</kbd></button>
          <b>{attempt.dials}</b> dial{attempt.dials === 1 ? '' : 's'}
          <button className="btn small" onClick={() => setDials(attempt.dials + 1)} aria-label="One more dial">+ <kbd>{k('dials_up')}</kbd></button>
        </div>
        {attempt.timerStart && <Timer start={attempt.timerStart} onReset={resetTimer} />}
        {attempt.to && attempt.to !== d.lead.phone_e164 && <span className="warn">Dialing {fmtPhone(attempt.to)}</span>}
      </div>
      <div className="row">
        <label className="field">
          <span>Caller ID used {defaultNumber.why && !changed && <em>({defaultNumber.why})</em>}</span>
          <select value={numberId} onChange={(e) => setNumberId(e.target.value)} style={changed && defaultNumber.known ? { borderColor: 'var(--warn)' } : undefined}>
            <option value="">Not recorded</option>
            {activeNumbers.map((n) => (
              <option key={n.id} value={n.id}>{n.label ? `${n.label} · ` : ''}{fmtPhone(n.e164)}{n.reputation_status === 'flagged' ? ' (flagged)' : ''}</option>
            ))}
          </select>
        </label>
        {changed && defaultNumber.known && (() => {
          // Only worth a warning when this lead already knows you by another number.
          const n = activeNumbers.find((x) => x.id === defaultNumber.id);
          const shown = n ? `${n.label ? `${n.label}, ` : ''}${fmtPhone(n.e164)}` : 'another number';
          return (
            <span className="warn">
              {d.state?.status === 'appointment_set'
                ? `This lead's appointment was set from ${shown}. They may not pick up a number they don't know.`
                : `You've reached this lead before from ${shown}. They may not pick up a number they don't know.`}
            </span>
          );
        })()}
        {!(changed && defaultNumber.known) && (() => {
          // You call leads from a number in their county's area code. Say so when this one isn't, and offer one that is.
          const codes = d.county_area_codes ?? [];
          const chosen = activeNumbers.find((x) => x.id === numberId);
          if (!codes.length || !chosen || codes.includes(chosen.e164.slice(2, 5))) return null;
          const local = activeNumbers.find((x) => codes.includes(x.e164.slice(2, 5)) && x.reputation_status !== 'flagged');
          return (
            <span className="warn">
              {d.lead.county ?? 'This county'} uses {codes.join('/')}; this number is {chosen.e164.slice(2, 5)}.{' '}
              {local && (
                <button className="btn small" onClick={() => setNumberId(local.id)}>
                  Use {local.label ? `${local.label}, ` : ''}{fmtPhone(local.e164)}
                </button>
              )}
            </span>
          );
        })()}
        {activeNumbers.length === 0 && <span className="help">Add your numbers on the Numbers page to record which one you used.</span>}
      </div>
      <div className="outcomes" role="group" aria-label="Outcome">
        {meta?.outcome_codes.map((o) => (
          <button key={o.code} className={`${code === o.code ? 'active' : ''} ${o.marks_dead ? 'dead' : ''}`} onClick={() => choose(o.code)}>
            {keys.outcomeKey[o.code] && <kbd>{keyLabel(keys.outcomeKey[o.code]!)}</kbd>}{o.label}
          </button>
        ))}
      </div>
      {code && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          {needsWhen && (
            <label className="field">
              <span>Call back at (your time)</span>
              <input id="when-input" ref={whenRef} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span>Talk minutes {attempt.timerStart && outcome?.counts_as_human_contact ? '(blank: from the timer)' : '(optional)'}</span>
            <input id="log-minutes" type="number" min={0} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 90 }} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            <span>Note (optional)</span>
            <input id="log-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn primary" onClick={save} disabled={saving}>Save <kbd>Enter</kbd></button>
          <button className="btn" onClick={() => setCode(null)}>Cancel <kbd>Esc</kbd></button>
        </div>
      )}
      {!code && <p className="help">After the call, press the outcome key, then Enter. Dialed more than once? Press <kbd>{k('dials_up')}</kbd> for each extra dial.</p>}
      {d.state?.status === 'invalid' && <RestoreBox d={d} onSaved={onRefresh} label="Marked as an invalid number or wrong person." />}
    </div>
  );
}

function RestoreBox({ d, onSaved, label }: { d: LeadDetail; onSaved: () => Promise<void>; label: string }) {
  const { toast } = useApp();
  const restore = async () => {
    await api.post(`/leads/${d.lead.id}/actions`, { action: 'restore', reason: 'restored from calling screen' });
    toast('Lead restored to the queue');
    await onSaved();
  };
  return (
    <div className="card" style={{ marginTop: 10 }}>
      {label} <button className="btn small" onClick={restore}>Restore to queue</button>
    </div>
  );
}
