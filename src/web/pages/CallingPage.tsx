import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { callbackFields, describeCallback, differentZone, readCallback } from '../when';
import { api, personAge, fmtMoney, fmtPhone, fmtRelative, newKey, type LeadDetail, type QueueResponse, type QueueItem } from '../api';
import { useApp } from '../App';
import { LeadSummary, CallHistory, Notes, StatusBadge } from '../components/LeadView';
import { EditLead } from '../components/EditLead';
import { LeadPage } from '../components/LeadPage';
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
/** Before: one list. Now: your last few lists, one per tab/search/group choice, so switching back finds it as you left it. */
const OLD_LIST_KEY = 'mpcrm.worklist';
const LISTS_KEY = 'mpcrm.worklists';
const KEEP_LISTS = 6;
const BUCKET_KEY = 'mpcrm.calling.bucket';
/** A lead opened outside the list (looked up for an incoming call, or from Today), and where to go back to. */
export const OPENED_KEY = 'mpcrm.openedLead';
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
  /** Callback picker: the day and the optional time, as typed. */
  day: string;
  time: string;
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
  /** The lead's time zone, so an undone callback comes back in their time. */
  tz: string | null;
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

function loadLists(): WorkList[] {
  try {
    const ls = JSON.parse(store(LISTS_KEY) ?? 'null') as WorkList[] | null;
    if (Array.isArray(ls)) return ls.filter((l) => l && typeof l.key === 'string' && Array.isArray(l.items));
    const old = JSON.parse(store(OLD_LIST_KEY) ?? 'null') as WorkList | null;
    return old && Array.isArray(old.items) ? [old] : [];
  } catch {
    return [];
  }
}

function loadList(key: string): WorkList | null {
  return loadLists().find((l) => l.key === key) ?? null;
}

/** Saves this list as the most recent one, keeping a few others. */
function saveList(l: WorkList) {
  const rest = loadLists().filter((x) => x.key !== l.key);
  store(LISTS_KEY, JSON.stringify([l, ...rest].slice(0, KEEP_LISTS)));
  store(OLD_LIST_KEY, null);
}

interface Opened {
  leadId: string;
  /** The list lead you were on, to go back to after the call. */
  backTo: string | null;
}

function loadOpened(): Opened | null {
  try {
    const o = JSON.parse(store(OPENED_KEY) ?? 'null') as Opened | null;
    return o && typeof o.leadId === 'string' ? o : null;
  } catch {
    return null;
  }
}

const BUCKET_KEYS = new Set<string>(BUCKETS.map((b) => b.key));

export function CallingPage() {
  const { toast, keys, calling, bumpStats } = useApp();
  const settings = calling?.settings;
  const [bucket, setBucketState] = useState<QueueItem['bucket'] | 'all'>(() => {
    const b = store(BUCKET_KEY);
    return b && BUCKET_KEYS.has(b) ? (b as QueueItem['bucket'] | 'all') : 'all';
  });
  const setBucket = (b: QueueItem['bucket'] | 'all') => {
    setBucketState(b);
    store(BUCKET_KEY, b);
  };
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
  const [opened, setOpenedState] = useState<Opened | null>(loadOpened);
  const setOpened = (o: Opened | null) => {
    setOpenedState(o);
    store(OPENED_KEY, o ? JSON.stringify(o) : null);
  };
  const lookupRef = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [attempt, setAttempt] = useState<Attempt>(freshAttempt);
  const [restore, setRestore] = useState<{ leadId: string; values: FormValues; n: number } | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [showScript, setShowScript] = useState(store(SCRIPT_KEY) === '1');
  const [editing, setEditing] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** After a save or skip with KDE Connect: the next lead's number goes to your phone once that lead is shown. */
  const autoSend = useRef<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const setList = useCallback((l: WorkList) => {
    setListState(l);
    saveList(l);
  }, []);
  const updateList = useCallback((f: (items: WorkItem[]) => WorkItem[]) => {
    setListState((l) => {
      if (!l) return l;
      const next = { ...l, items: f(l.items) };
      saveList(next);
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

  /**
   * Adds callbacks that came due since the list was built, at the top. When everything in the list is worked,
   * the rest of the queue (new imports, retries come due) is added below, so the crossed-out leads stay.
   */
  const mergeDue = useCallback(async () => {
    const q = await fetchQueue();
    if (!q) return;
    updateList((items) => {
      const have = new Set(items.map((i) => i.lead_id));
      const due = q.items.filter((i) => i.bucket === 'callback_due' && !have.has(i.lead_id));
      const rest = q.items.filter((i) => !have.has(i.lead_id) && !due.includes(i));
      const allWorked = !items.some((i) => !i.done);
      setMore(allWorked ? 0 : rest.length);
      if (!due.length && !(allWorked && rest.length)) return items;
      return [...due.map((i) => ({ ...i, due_now: true })), ...items, ...(allWorked ? rest : [])];
    });
  }, [fetchQueue, updateList]);

  // A new filter, tab or search makes a new list; the same one is kept, crossed-out leads and all,
  // across page changes, refreshes and switching back. Only "Refresh list" clears the worked leads out.
  useEffect(() => {
    const stored = loadList(listKey);
    if (stored) {
      setListState(stored);
      saveList(stored);
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
      if (loadOpened()?.leadId === id) {
        setOpenedState(null);
        store(OPENED_KEY, null);
      }
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

  // Once the next lead is loaded, its current number (not a ruled-out one) goes to your phone.
  useEffect(() => {
    if (!detail || autoSend.current !== detail.lead.id || detail.lead.id !== selected) return;
    autoSend.current = null;
    const phone = detail.state?.active_phone_e164 ?? detail.lead.phone_e164;
    if (phone && ['new', 'retry', 'callback'].includes(detail.state?.status ?? 'new')) void dial(phone);
  }, [detail]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Shows a lead (looked up for an incoming call, or from Today) without touching your list. */
  const openOutside = useCallback((id: string) => {
    setOpenedState((o) => {
      // Already off on a looked-up lead: keep the list lead you started from.
      const backTo = o && o.leadId === selected ? o.backTo : selected;
      const next = { leadId: id, backTo: backTo === id ? o?.backTo ?? null : backTo };
      store(OPENED_KEY, JSON.stringify(next));
      return next;
    });
    select(id);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened from the Today page or a callback alert while the Calling page is already showing.
  useEffect(() => {
    const f = (e: Event) => {
      openOutside((e as CustomEvent<string>).detail);
      void mergeDue();
    };
    window.addEventListener('mpcrm:open-lead', f);
    return () => window.removeEventListener('mpcrm:open-lead', f);
  }, [mergeDue, openOutside]);

  const items = list?.items ?? [];
  const idx = items.findIndex((i) => i.lead_id === selected);
  /** The lead on screen was opened on purpose outside the list (or is a looked-up lead that is also in it). */
  const outside = !!selected && opened?.leadId === selected;
  // Nothing selected yet (first visit, or the lead left the list): start at the top.
  useEffect(() => {
    if (list && (!selected || (!list.items.some((i) => i.lead_id === selected) && !outside)) && !detail) {
      const first = list.items.find((i) => !i.done) ?? list.items[0];
      if (first) select(first.lead_id);
    }
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps
  const left = items.filter((i) => !i.done).length;

  /** Picking a lead in the list ends a lookup. */
  const pick = (id: string) => {
    if (opened) setOpened(null);
    select(id);
  };

  /** Back to the list lead you were on before the lookup (or the next one to call). */
  const backToList = () => {
    const back = opened?.backTo && items.some((i) => i.lead_id === opened.backTo) ? opened.backTo : null;
    setOpened(null);
    const to = back ?? items.find((i) => !i.done && i.lead_id !== selected)?.lead_id ?? items[0]?.lead_id ?? null;
    select(to);
  };

  /** The next lead you haven't worked yet, below the current one first. */
  const nextUnworked = useCallback(
    (from = idx) => {
      const after = items.slice(from + 1).find((i) => !i.done);
      return after ?? items.slice(0, Math.max(0, from)).find((i) => !i.done) ?? null;
    },
    [items, idx],
  );

  /** With KDE Connect and "send the next number" on, the next lead's number goes to your phone when it's shown. */
  const queueAutoSend = (n: WorkItem | null | undefined) => {
    autoSend.current = n && settings?.dial_method === 'kdeconnect' && settings?.auto_send_next !== false ? n.lead_id : null;
  };

  const goNext = useCallback((send = false) => {
    const n = nextUnworked();
    if (send) queueAutoSend(n);
    if (n) pick(n.lead_id);
    else toast('You\'ve worked the whole list. Press "Refresh list" to load more.');
  }, [nextUnworked, toast, settings, opened]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = useCallback(
    (step: 1 | -1) => {
      if (!items.length) return;
      const i = idx < 0 ? 0 : Math.min(items.length - 1, Math.max(0, idx + step));
      pick(items[i]!.lead_id);
    },
    [items, idx, opened], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const markDone = (leadId: string, done: WorkItem['done']) =>
    updateList((xs) => xs.map((i) => (i.lead_id === leadId ? { ...i, done, due_now: false } : i)));

  const skip = useCallback(async () => {
    if (!selected) return;
    try {
      await api.post(`/leads/${selected}/actions`, { action: 'skip' });
    } catch (e: any) {
      toast(`Couldn't skip: ${e.message}`, 'error');
      return;
    }
    markDone(selected, { label: 'Skipped', dials: 0 });
    goNext(true);
  }, [selected, goNext, toast]); // eslint-disable-line react-hooks/exhaustive-deps

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
        lead_id: string; outcome_code: string | null; callback_due_at: string | null; callback_any_time: boolean;
        dial_count: number; talk_seconds: number | null; from_number_id: string | null; note: string | null;
      }>(`/calls/${s.callId}/void`, { reason: 'undo' });
      const cb = callbackFields(r.callback_due_at, r.callback_any_time, s.tz);
      setRestore({
        leadId: s.leadId,
        n: Date.now(),
        values: {
          code: r.outcome_code,
          day: cb.day,
          time: cb.time,
          minutes: r.talk_seconds ? String(Math.round(r.talk_seconds / 60)) : '',
          note: r.note ?? '',
          numberId: r.from_number_id,
        },
      });
      setAttempt({ dials: r.dial_count, timerStart: null, to: null });
      markDone(s.leadId, null);
      // A looked-up lead outside the list comes back as one, so the list stays as it is.
      if (!items.some((i) => i.lead_id === s.leadId)) setOpened({ leadId: s.leadId, backTo: selected });
      select(s.leadId);
      toast(`Undone. Pick the right outcome for ${s.name}.`);
      bumpStats();
      await loadDetail(s.leadId);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [saved, toast, bumpStats, loadDetail, items, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const modalOpen = editing || !!qr;
  /** The lead on screen is the one selected. Just after you move on, keys that act on a lead wait for it to load. */
  const ready = !!detail && detail.lead.id === selected;
  const phoneNow = detail ? detail.state?.active_phone_e164 ?? detail.lead.phone_e164 : null;
  const otherPhone = detail ? otherNumber(detail) : null;
  // Layout effect, so the keys act on the lead you can see as soon as it's on screen.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const act = (a: Parameters<typeof isAction>[1]) => isAction(keys, a, e);
      const leadKey = ['dial', 'dial_alt', 'dials_up', 'dials_down', 'note', 'edit', 'skip'].some((a) => act(a as Parameters<typeof isAction>[1]));
      if (leadKey && !ready) { e.preventDefault(); return; }
      if (act('list_down')) { e.preventDefault(); move(1); }
      else if (act('list_up')) { e.preventDefault(); move(-1); }
      else if (act('next')) { e.preventDefault(); goNext(); }
      else if (act('skip')) { e.preventDefault(); void skip(); }
      else if (act('search')) { e.preventDefault(); searchRef.current?.focus(); }
      else if (act('lookup')) { e.preventDefault(); lookupRef.current?.focus(); }
      else if (act('note')) { e.preventDefault(); document.getElementById('note-input')?.focus(); }
      else if (act('dial')) { e.preventDefault(); void dial(phoneNow); }
      else if (act('dial_alt')) {
        e.preventDefault();
        if (otherPhone) void dial(otherPhone);
        else toast('This lead has no other working number');
      }
      else if (act('dials_up')) { e.preventDefault(); setAttempt((a) => ({ ...a, dials: a.dials + 1 })); }
      else if (act('dials_down')) { e.preventDefault(); setAttempt((a) => ({ ...a, dials: Math.max(1, a.dials - 1) })); }
      else if (act('undo')) { e.preventDefault(); void undo(); }
      else if (act('edit')) { if (detail) { e.preventDefault(); setEditing(true); } }
      else if (act('script')) { e.preventDefault(); setShowScript((v) => { store(SCRIPT_KEY, v ? '0' : '1'); return !v; }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys, move, goNext, skip, dial, undo, detail, modalOpen, ready, phoneNow, otherPhone, toast]);

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
    // A looked-up lead (an incoming call): back to where you were in the list, nothing sent to the phone.
    if (opened?.leadId === s.leadId) {
      backToList();
      void mergeDue();
      return;
    }
    const n = items.slice(Math.max(0, items.findIndex((i) => i.lead_id === s.leadId)) + 1).find((i) => !i.done && i.lead_id !== s.leadId)
      ?? items.find((i) => !i.done && i.lead_id !== s.leadId);
    queueAutoSend(n);
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
                  onClick={() => pick(i.lead_id)}
                >
                  <span className="name">{i.name}</span>
                  {i.done ? (
                    <span className="badge done">{i.done.label}{i.done.dials > 1 ? ` · ${i.done.dials} dials` : ''}</span>
                  ) : (
                    <span className={`badge ${i.bucket}`}>
                      {i.due_now ? 'due now' : i.bucket === 'callback_due' ? (i.needs_time ? 'callback, needs a time' : i.any_time ? 'callback, any time' : 'callback') : i.bucket}
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
            <kbd>{k('list_up')}</kbd><kbd>{k('list_down')}</kbd> move <kbd>{k('skip')}</kbd> skip <kbd>{k('search')}</kbd> search <kbd>{k('dial')}</kbd> {dialLabel.toLowerCase()} <kbd>{k('dial_alt')}</kbd> other number{' '}
            <kbd>{k('dials_down')}</kbd><kbd>{k('dials_up')}</kbd> dials <kbd>Enter</kbd> save and next <kbd>{k('undo')}</kbd> undo <kbd>{k('note')}</kbd> note{' '}
            <kbd>{k('edit')}</kbd> edit <kbd>{k('script')}</kbd> script <kbd>{k('lookup')}</kbd> look up a caller
          </span>
        </header>
      </section>

      <section className="panel" aria-label="Current lead">
        <header>
          <CallerLookup inputRef={lookupRef} hotkey={k('lookup')} onOpen={openOutside} />
        </header>
        <div className="body">
          {saved && <UndoBar saved={saved} undoKey={k('undo')} onUndo={undo} onExpire={() => setSaved(null)} />}
          {detail && (outside || idx < 0) && detail.lead.id === selected && (
            <div className="lookup-bar" role="status">
              {idx < 0 ? 'Not in your calling list.' : 'Looked up. It\'s also in your list.'} Your list on the left is unchanged.
              <button className="btn small" onClick={backToList}>Back to list</button>
            </div>
          )}
          {!detail ? (
            <div className="empty">Select a lead from the list, or import leads first.</div>
          ) : (
            <>
              <LeadSummary d={detail} onDial={dial} dialLabel={dialLabel} dialKey={k('dial')} altKey={k('dial_alt')} onEdit={() => setEditing(true)} editKey={k('edit')} />
              {showScript && <ScriptPanel d={detail} />}
              <LogCall
                key={`${detail.lead.id}-${restore?.leadId === detail.lead.id ? restore.n : 0}`}
                d={detail}
                attempt={attempt}
                setDials={(n) => setAttempt((a) => ({ ...a, dials: Math.max(1, n) }))}
                resetTimer={() => setAttempt((a) => ({ ...a, timerStart: null }))}
                restore={restore?.leadId === detail.lead.id ? restore.values : null}
                active={ready}
                onSaved={onSaved}
                onRefresh={refreshDetail}
              />
              <section className="calls-notes" aria-label="History">
                <div>
                  <h3>Calls</h3>
                  <CallHistory calls={detail.calls} onChange={refreshDetail} />
                </div>
                <div>
                  <h3>Notes</h3>
                  <Notes key={detail.lead.id} d={detail} onChange={refreshDetail} />
                </div>
              </section>
            </>
          )}
        </div>
      </section>

      {detail ? <LeadPage d={detail} /> : <section className="panel lead-page" aria-label="Lead page" />}
      {editing && detail && <EditLead d={detail} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await refreshDetail(); }} />}
      {qr && <DialQr e164={qr} onClose={() => setQr(null)} />}
    </div>
  );
}

interface LookupRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_e164: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  status: string;
  attempts_total: number;
  last_call_at: string | null;
}

/**
 * Incoming call: type part of their number (or a name) and open the lead, any status, without touching the list.
 * Enter opens the top match; the arrow keys pick another.
 */
function CallerLookup({ inputRef, hotkey, onOpen }: { inputRef: RefObject<HTMLInputElement | null>; hotkey: string; onOpen: (id: string) => void }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<LookupRow[] | null>(null);
  const [hi, setHi] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const s = q.trim();
    const digits = s.replace(/\D/g, '');
    // Four digits are enough for a number; two letters for a name.
    if (digits.length < 4 && s.replace(/[^a-z]/gi, '').length < 2) {
      setRows(null);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await api.get<LookupRow[]>('/leads', { search: digits.length >= 4 ? digits : s });
        if (n === seq.current) {
          setRows(r.slice(0, 8));
          setHi(0);
        }
      } catch (e: any) {
        toast(e.message, 'error');
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q, toast]);

  const open = (r: LookupRow | undefined) => {
    if (!r) return;
    onOpen(r.id);
    setQ('');
    setRows(null);
    inputRef.current?.blur();
  };

  return (
    <div className="lookup">
      <input
        ref={inputRef}
        type="search"
        placeholder={`Incoming call? Type their number to pull them up  ( ${hotkey} )`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setQ(''); setRows(null); (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'Enter') { e.preventDefault(); open(rows?.[hi]); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min((rows?.length ?? 1) - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
        }}
        onBlur={() => setTimeout(() => setRows(null), 150)}
        aria-label="Look up a caller by phone number"
        autoComplete="off"
      />
      {rows && (
        <ul className="lookup-results" role="listbox">
          {rows.length === 0 && <li className="muted">No lead has that number.</li>}
          {rows.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''}
              onMouseDown={(e) => { e.preventDefault(); open(r); }} onMouseEnter={() => setHi(i)}>
              <b>{[r.first_name, r.last_name].filter(Boolean).join(' ') || 'No name'}</b> <StatusBadge status={r.status} />
              <span className="sub">
                {fmtPhone(r.phone_e164)} · {r.county ? `${r.county} Co.` : r.city ?? r.state ?? '?'} · {r.attempts_total ? `${r.attempts_total} attempt${r.attempts_total > 1 ? 's' : ''}, last ${fmtRelative(r.last_call_at)}` : 'never called'}
              </span>
            </li>
          ))}
        </ul>
      )}
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
    address: l.address_line, city: l.city, state: l.state, county: l.county, age: personAge(l) != null ? String(personAge(l)) : null,
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
  d, attempt, setDials, resetTimer, restore, active, onSaved, onRefresh,
}: {
  d: LeadDetail;
  attempt: Attempt;
  setDials: (n: number) => void;
  resetTimer: () => void;
  restore: FormValues | null;
  /** False for a moment after you move on, until the next lead is on screen: keys wait. */
  active: boolean;
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
  const [day, setDay] = useState(restore?.day ?? '');
  const [time, setTime] = useState(restore?.time ?? '');
  const [minutes, setMinutes] = useState(restore?.minutes ?? '');
  const [note, setNote] = useState(restore?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState(newKey());
  const dayRef = useRef<HTMLInputElement>(null);

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
      setDay((v) => v || 'tomorrow');
      setTimeout(() => { dayRef.current?.focus(); dayRef.current?.select(); }, 0);
      return;
    }
    // No answer and Bad number need nothing more, so they save straight away (Undo still catches a wrong key).
    if (calling?.settings.instant_save !== false && o && instantOutcome(o)) void saveRef.current(c);
  }, [meta, calling]);

  // Talk time from the timer, only when someone picked up and you didn't type minutes yourself.
  const timerSeconds = (o: typeof outcome) =>
    attempt.timerStart && o?.counts_as_human_contact && calling?.settings.use_timer !== false
      ? Math.round((Date.now() - attempt.timerStart) / 1000)
      : null;

  const save = useCallback(async (codeNow: string | null = code) => {
    if (!codeNow || saving) return;
    const o = meta?.outcome_codes.find((x) => x.code === codeNow) ?? null;
    const cb = o?.requires_callback_time ? readCallback(day, time, new Date(), d.lead.time_zone) : null;
    if (cb && 'error' in cb) {
      toast(cb.error, 'error');
      dayRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const r = await api.post<{ call_id: string }>(`/leads/${d.lead.id}/calls`, {
        idempotency_key: key,
        from_number_id: numberId || null,
        to_e164: attempt.to,
        outcome_code: codeNow,
        callback_due_at: cb ? cb.at.toISOString() : null,
        callback_any_time: cb ? cb.anyTime : null,
        talk_seconds: minutes ? Number(minutes) * 60 : timerSeconds(o),
        dial_count: attempt.dials,
        note: note || null,
      });
      if (numberId) store(LAST_NUMBER_KEY, numberId);
      setCode(null);
      setDay('');
      setTime('');
      setMinutes('');
      setNote('');
      setKey(newKey());
      await onSaved({
        callId: r.call_id, leadId: d.lead.id, name: [d.lead.first_name, d.lead.last_name].filter(Boolean).join(' ') || 'this lead',
        label: o?.label ?? codeNow, dials: attempt.dials, at: Date.now(), tz: d.lead.time_zone ?? null,
      });
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }, [code, saving, meta, day, time, key, numberId, minutes, note, d.lead.id, toast, onSaved, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveRef = useRef(save);
  saveRef.current = save;

  // Layout effect: the hotkeys are live as soon as the lead is on screen, so a fast keypress isn't lost.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-back') || !active) return;
      if (e.key === 'Enter' && code && (!isTyping(e) || e.ctrlKey || e.metaKey || ['callback-day', 'callback-time', 'log-note', 'log-minutes'].includes((e.target as HTMLElement).id))) {
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
  }, [keys, code, save, choose, active]);

  if (!d.lead.phone_e164 && !d.lead.phone2_e164 && !d.lead.phone3_e164) return <p className="error">This lead has no valid phone number.</p>;
  if (d.state?.status === 'dead') return <RestoreBox d={d} onSaved={onRefresh} label={d.state.block_reason ? `${d.state.block_reason}.` : 'This lead is in the dead pile.'} />;

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
          {needsWhen && (() => {
            const cb = readCallback(day, time, new Date(), d.lead.time_zone);
            const theirs = differentZone(d.lead.time_zone);
            return (
              <div className="callback-picker">
                <label className="field">
                  <span>Call back on</span>
                  <input id="callback-day" ref={dayRef} value={day} onChange={(e) => setDay(e.target.value)} onFocus={(e) => e.target.select()}
                    placeholder="t, m, fri, 10/24" style={{ width: 120 }} autoComplete="off" />
                </label>
                <label className="field">
                  <span>At (optional{theirs ? ', their time' : ''})</span>
                  <input id="callback-time" value={time} onChange={(e) => setTime(e.target.value)} placeholder="any time" style={{ width: 90 }} autoComplete="off" />
                </label>
                <span className={'error' in cb ? 'help warn' : 'help'} aria-live="polite">{'error' in cb ? (day ? cb.error : '') : describeCallback(cb, new Date(), d.lead.time_zone)}</span>
              </div>
            );
          })()}
          <label className="field">
            <span>Talk minutes {attempt.timerStart && outcome?.counts_as_human_contact ? '(blank: from the timer)' : '(optional)'}</span>
            <input id="log-minutes" type="number" min={0} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 90 }} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            <span>Note (optional)</span>
            <input id="log-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>Save <kbd>Enter</kbd></button>
          <button className="btn" onClick={() => setCode(null)}>Cancel <kbd>Esc</kbd></button>
        </div>
      )}
      {!code && (
        <p className="help">
          {calling?.settings.instant_save !== false
            ? 'After the call, press the outcome key. No answer and Bad number save right away; the others save with Enter.'
            : 'After the call, press the outcome key, then Enter.'}{' '}
          Dialed more than once? Press <kbd>{k('dials_up')}</kbd> for each extra dial first.
        </p>
      )}
      {d.state?.status === 'invalid' && <RestoreBox d={d} onSaved={onRefresh} label={d.state.block_reason ? `${d.state.block_reason}.` : 'Marked as a bad number.'} />}
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

/** Outcomes that need nothing more than the key: no callback time, and nobody was reached (so no talk time or note). */
function instantOutcome(o: { requires_callback_time: number | boolean; counts_as_human_contact: number | boolean }) {
  return !o.requires_callback_time && !o.counts_as_human_contact;
}

/** The lead's next working number after the one being called, if it has one. */
export function otherNumber(d: LeadDetail): string | null {
  const blocked: string[] = d.state?.blocked_phones_json ? JSON.parse(d.state.blocked_phones_json) : [];
  const now = d.state?.active_phone_e164 ?? d.lead.phone_e164;
  return [d.lead.phone_e164, d.lead.phone2_e164, d.lead.phone3_e164].find((p) => p && p !== now && !blocked.includes(p)) ?? null;
}
