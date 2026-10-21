import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { callbackFields, describeCallback, differentZone, readCallback } from '../when';
import { api, personAge, fmtMoney, fmtPhone, fmtRelative, fmtDateTime, newKey, type LeadDetail, type CallListItem, type CallListResponse, type RecentOutcome } from '../api';
import { useApp } from '../App';
import { LeadSummary, CallHistory, Notes, StatusBadge, toggleCalledBack } from '../components/LeadView';
import { EditLead } from '../components/EditLead';
import { LeadPage } from '../components/LeadPage';
import { DialQr } from '../components/DialQr';
import { ClearListDialog, SavedListsDialog, suggestListName } from '../components/CallListDialogs';
import { fillScript, isAction, isTyping, keyLabel, normKey, type KeyMap } from '../shortcuts';

const SELECTED_KEY = 'mpcrm.selectedLead';
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
  /** When this lead came on screen, for the time spent on it. */
  shownAt: number;
}
const freshAttempt = (): Attempt => ({ dials: 1, timerStart: null, to: null, shownAt: Date.now() });

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

/** A lead on your call list. The list is kept by the app; it only changes when you add, skip, remove or clear. */
type WorkItem = CallListItem;

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

export function CallingPage() {
  const { toast, keys, calling, bumpStats } = useApp();
  const settings = calling?.settings;
  const { go } = useApp();
  const [list, setListState] = useState<CallListResponse | null>(null);
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
  const [listDialog, setListDialog] = useState<'clear' | 'saved' | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** After a save or skip with KDE Connect: the next lead's number goes to your phone once that lead is shown. */
  const autoSend = useRef<string | null>(null);

  /** Local change shown at once (a lead just worked), until the list comes back from the app. */
  const updateList = useCallback((f: (items: WorkItem[]) => WorkItem[]) => {
    setListState((l) => (l ? { ...l, items: f(l.items) } : l));
  }, []);

  const select = (id: string | null) => {
    setSelected(id);
    store(SELECTED_KEY, id);
  };

  const loadList = useCallback(async () => {
    try {
      setListState(await api.get<CallListResponse>('/call-list'));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);
  useEffect(() => void loadList(), [loadList]);

  const clearWorked = async () => {
    try {
      const r = await api.post<{ removed: number }>('/call-list/clear-worked', {});
      toast(`Cleared ${r.removed} worked lead${r.removed === 1 ? '' : 's'}`);
      await loadList();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  /** After the whole list changed (cleared or a saved list loaded): start again at the top. */
  const afterSwap = async () => {
    setListDialog(null);
    setOpened(null);
    const l = await api.get<CallListResponse>('/call-list');
    setListState(l);
    select(l.items.find((i) => !i.done)?.lead_id ?? l.items[0]?.lead_id ?? null);
  };

  const clearList = async (saveAs: string | null) => {
    try {
      const r = await api.post<{ removed: number; saved: { name: string } | null }>('/call-list/clear', { save_as: saveAs });
      toast(r.saved ? `Call list cleared. "${r.saved.name}" is in Saved lists.` : `Call list cleared (${r.removed} lead${r.removed === 1 ? '' : 's'})`);
      await afterSwap();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const loadSaved = async (id: string, saveCurrentAs: string | null) => {
    try {
      const name = list?.saved_lists.find((l) => l.id === id)?.name ?? 'list';
      const r = await api.post<{ loaded: number; saved: { name: string } | null }>(`/saved-lists/${id}/load`, { save_current_as: saveCurrentAs });
      toast(`Loaded "${name}" (${r.loaded} lead${r.loaded === 1 ? '' : 's'})${r.saved ? `. "${r.saved.name}" is in Saved lists.` : ''}`);
      await afterSwap();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const deleteSaved = async (id: string) => {
    try {
      await api.del(`/saved-lists/${id}`);
      await loadList();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const remove = async (id: string) => {
    try {
      await api.del(`/call-list/${id}`);
      if (selected === id) {
        const n = items.find((i) => i.lead_id !== id && !i.done);
        select(n?.lead_id ?? null);
      }
      await loadList();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

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
    };
    window.addEventListener('mpcrm:open-lead', f);
    return () => window.removeEventListener('mpcrm:open-lead', f);
  }, [openOutside]);

  const items = useMemo(() => list?.items ?? [], [list]);
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
    else toast('You\'ve worked the whole list. Clear the worked leads, or add more from Leads.');
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
    updateList((xs) => xs.map((i) => (i.lead_id === leadId ? { ...i, done } : i)));

  /** Skip: the lead goes to the bottom of the list and you move on to the next one. */
  const skip = useCallback(async () => {
    if (!selected) return;
    if (idx < 0) return backToList();
    const n = nextUnworked();
    try {
      await api.post(`/call-list/${selected}/skip`, {});
    } catch (e: any) {
      toast(`Couldn't skip: ${e.message}`, 'error');
      return;
    }
    queueAutoSend(n);
    if (n && n.lead_id !== selected) pick(n.lead_id);
    await loadList();
  }, [selected, idx, nextUnworked, toast, loadList]); // eslint-disable-line react-hooks/exhaustive-deps

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
        dial_count: number; talk_seconds: number | null; lead_seconds: number | null; from_number_id: string | null; note: string | null;
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
      // The clock on this lead carries on from where it was when you saved.
      setAttempt({ dials: r.dial_count, timerStart: null, to: null, shownAt: Date.now() - (r.lead_seconds ?? 0) * 1000 });
      markDone(s.leadId, null);
      void loadList();
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

  const modalOpen = editing || !!qr || !!listDialog;
  /** The lead on screen is the one selected. Just after you move on, keys that act on a lead wait for it to load. */
  const ready = !!detail && detail.lead.id === selected;
  const phoneNow = detail ? detail.state?.active_phone_e164 ?? detail.lead.phone_e164 : null;
  const otherPhone = detail ? otherNumber(detail) : null;
  /** The "called me back" mark changed: shown at once on the lead and its list row. */
  const calledBack = useCallback((leadId: string, at: string | null) => {
    setDetail((d) => (d && d.lead.id === leadId ? { ...d, called_back_at: at } : d));
    updateList((xs) => xs.map((i) => (i.lead_id === leadId ? { ...i, called_back_at: at } : i)));
  }, [updateList]);

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
      else if (act('search')) { e.preventDefault(); lookupRef.current?.focus(); }
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
      else if (act('called_back')) { if (ready && detail) { e.preventDefault(); void toggleCalledBack(detail, toast).then((at) => calledBack(detail.lead.id, at)); } }
      else if (act('script')) { e.preventDefault(); setShowScript((v) => { store(SCRIPT_KEY, v ? '0' : '1'); return !v; }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys, move, goNext, skip, dial, undo, detail, modalOpen, ready, phoneNow, otherPhone, toast, calledBack]);

  const refreshDetail = async () => {
    await Promise.all([loadDetail(selected), loadList()]);
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
      void loadList();
      return;
    }
    const n = items.slice(Math.max(0, items.findIndex((i) => i.lead_id === s.leadId)) + 1).find((i) => !i.done && i.lead_id !== s.leadId)
      ?? items.find((i) => !i.done && i.lead_id !== s.leadId);
    queueAutoSend(n);
    if (n) select(n.lead_id);
    else await refreshDetail();
    void loadList();
  };

  const k = (a: keyof KeyMap['actions']) => keyLabel(keys.actions[a]?.[0] ?? '');
  const dialLabel = settings?.dial_method === 'qr' ? 'Show QR' : settings?.dial_method === 'kdeconnect' ? 'Dial on phone' : 'Copy number';

  return (
    <div className="calling">
      <section className="panel" aria-label="Queue">
        <header>
          <div className="row list-head">
            <span><b>{left}</b> to call · {items.length - left} done</span>
            {items.length - left > 0 && (
              <button className="btn small" onClick={() => void clearWorked()} title="Take the worked leads off the list. Their calls stay in Call history.">
                Clear worked
              </button>
            )}
            <button className="btn small" onClick={() => go('leads')} title="Pick leads to call on the Leads page">Add leads</button>
          </div>
          <div className="row list-head">
            <span className="list-name">{list?.name ? <>List: <b>{list.name}</b></> : null}</span>
            <span className="row" style={{ gap: 4 }}>
              {items.length > 0 && (
                <button className="btn small" onClick={() => setListDialog('clear')} title="Empty the call list, keeping it as a saved list if you want">
                  Clear list
                </button>
              )}
              <button className="btn small" onClick={() => setListDialog('saved')} title="Lists you put away to call later">
                Saved lists{list?.saved_lists.length ? ` (${list.saved_lists.length})` : ''}
              </button>
            </span>
          </div>
        </header>
        {listDialog === 'clear' && (
          <ClearListDialog
            title={`Clear the call list (${items.length} lead${items.length === 1 ? '' : 's'})?`}
            confirmLabel="Clear list"
            count={items.length}
            defaultName={suggestListName(items, list?.name ?? null)}
            onConfirm={clearList}
            onCancel={() => setListDialog(null)}
          />
        )}
        {listDialog === 'saved' && list && (
          <SavedListsDialog
            lists={list.saved_lists}
            count={items.length}
            defaultName={suggestListName(items, list.name)}
            onLoad={loadSaved}
            onDelete={deleteSaved}
            onClose={() => setListDialog(null)}
          />
        )}
        <div className="body">
          {list && items.length > 0 && left === 0 && (
            <div className="list-done" role="status">
              <b>List done.</b> Every lead on it has been worked.
              <button className="btn small primary" onClick={() => void clearWorked()}>Clear worked leads</button>
            </div>
          )}
          {!list ? null : items.length === 0 ? (
            <div className="empty">
              Your call list is empty.
              <div className="help">Pick leads on the Leads page, or import a file. New imports go straight onto this list.</div>
              <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
                <button className="btn small primary" onClick={() => go('leads')}>Go to Leads</button>
                <button className="btn small" onClick={() => go('import')}>Import</button>
              </div>
            </div>
          ) : (
            <ul className="queue-list" ref={listRef}>
              {items.map((i) => (
                <li
                  key={i.lead_id}
                  data-lead={i.lead_id}
                  className={`${selected === i.lead_id ? 'selected' : ''} ${i.done ? 'done' : ''}`}
                  onClick={() => pick(i.lead_id)}
                >
                  <span className="name">{i.name}</span>
                  <span className="row" style={{ gap: 4 }}>
                    {i.called_back_at && <span className="badge called-back" title={`Called you back ${fmtDateTime(i.called_back_at)}`}>✓ called back</span>}
                    {i.done ? (
                      <span className="badge done">{i.done.label}{i.done.dials > 1 ? ` · ${i.done.dials} dials` : ''}</span>
                    ) : i.status === 'callback' ? (
                      <span className="badge callback" title="A callback you set for this lead">{i.callback_due_at ? `callback ${fmtDateTime(i.callback_due_at)}` : 'callback'}</span>
                    ) : i.attempts_total === 0 ? (
                      <span className="badge new">new</span>
                    ) : null}
                    <button
                      className="icon-btn"
                      title="Take this lead off the list"
                      aria-label={`Remove ${i.name} from the list`}
                      onClick={(e) => { e.stopPropagation(); void remove(i.lead_id); }}
                    >×</button>
                  </span>
                  <span className="sub">
                    {fmtPhone(i.phone_e164)} · {i.county ? `${i.county} Co.` : i.state ?? '?'} · {i.attempts_total ? `${i.attempts_total} attempt${i.attempts_total > 1 ? 's' : ''}, last ${fmtRelative(i.last_call_at)}` : 'never called'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {list && list.recent.length > 0 && <Recent items={list.recent} onOpen={openOutside} />}
        </div>
        <header style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}>
          <span className="help">
            <kbd>{k('list_up')}</kbd><kbd>{k('list_down')}</kbd> move <kbd>{k('skip')}</kbd> skip to the bottom <kbd>{k('dial')}</kbd> {dialLabel.toLowerCase()} <kbd>{k('dial_alt')}</kbd> other number{' '}
            <kbd>{k('dials_down')}</kbd><kbd>{k('dials_up')}</kbd> dials <kbd>Enter</kbd> save and next <kbd>{k('undo')}</kbd> undo <kbd>{k('note')}</kbd> note{' '}
            <kbd>{k('edit')}</kbd> edit <kbd>{k('script')}</kbd> script <kbd>{k('lookup')}</kbd> look up a caller <kbd>{k('called_back')}</kbd> called me back
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
              <LeadSummary d={detail} onDial={dial} dialLabel={dialLabel} dialKey={k('dial')} altKey={k('dial_alt')} onEdit={() => setEditing(true)} editKey={k('edit')}
                calledBackKey={k('called_back')} onCalledBack={(at) => calledBack(detail.lead.id, at)} />
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
        const r = (await api.get<{ rows: LookupRow[] }>('/leads', { search: digits.length >= 4 ? digits : s })).rows;
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
        lead_seconds: Math.round((Date.now() - attempt.shownAt) / 1000),
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
  if (d.state?.status === 'dead') return <RestoreBox d={d} onSaved={onRefresh} label={d.state.block_reason ? `${d.state.block_reason}.` : d.state?.last_outcome_code === 'dnc_request' ? 'Asked not to be called again. This lead is in the dead pile.' : 'This lead is in the dead pile.'} />;

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

/** The last outcomes you set, newest first: click one to open that lead and fix it, even after clearing the list. */
function Recent({ items, onOpen }: { items: RecentOutcome[]; onOpen: (id: string) => void }) {
  return (
    <details className="recent" open>
      <summary>Recent outcomes</summary>
      <ul>
        {items.map((r) => (
          <li key={r.call_id}>
            <button className="link" onClick={() => onOpen(r.lead_id)} title="Open this lead to check or change the outcome">
              {r.name || '(no name)'}
            </button>
            <span className="muted"> · {r.label} · {fmtRelative(r.entered_at)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
