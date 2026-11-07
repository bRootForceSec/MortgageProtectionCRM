import { useState, type ReactNode } from 'react';
import { api, fmtDateTime, type AddResult, type CallListItem, type SavedList, type SkippedLead } from '../api';

// Dialogs for saving and swapping call lists: Save as, Load a saved list, and clear or replace the list
// (saving the old one first if it has changes that aren't saved).

/** Sent on window when the call list changed from outside the page showing it (Add anyway), so it reloads. */
export const CALL_LIST_CHANGED = 'mpcrm:call-list-changed';

/** A name for the current list: its saved name, or its main county and today's date. */
export function suggestListName(items: Pick<CallListItem, 'county' | 'state'>[], name: string | null): string {
  if (name) return name;
  const counts = new Map<string, number>();
  for (const i of items) {
    const k = i.county ? `${i.county} Co.` : i.state ?? '';
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const day = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${top ?? 'Call list'} · ${day}`;
}

/** Where the current list stands, for the dialogs that take its place. */
export interface CurrentList {
  count: number;
  /** Its saved list's name, when it is one. */
  savedName: string | null;
  unsaved: boolean;
}

/**
 * Asks whether to save the current list before it goes, when it has changes that aren't saved. Ticked by
 * default. A list that is saved and unchanged just says so: it can be loaded again any time.
 */
function KeepCurrent(props: { current: CurrentList; keep: boolean; setKeep: (v: boolean) => void; name: string; setName: (v: string) => void }) {
  const { count, savedName, unsaved } = props.current;
  if (!count) return null;
  if (!unsaved) {
    return <p className="help" style={{ marginTop: 0 }}>Your current list is saved as <b>{savedName}</b>, so you can load it again any time.</p>;
  }
  return (
    <div className="keep-list">
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={props.keep} onChange={(e) => props.setKeep(e.target.checked)} />
        {savedName ? `Save the changes to the current list first` : `Save the ${count} lead${count === 1 ? '' : 's'} on the current list first, to call later`}
      </label>
      {props.keep && (
        <label className="field">
          <span>Name</span>
          <input aria-label="Saved list name" value={props.name} maxLength={120} onChange={(e) => props.setName(e.target.value)} autoFocus />
        </label>
      )}
    </div>
  );
}

/** The name to keep the current list under before it's replaced, or null to let it go. */
function useKeep(current: CurrentList, defaultName: string) {
  const [keep, setKeep] = useState(true);
  const [name, setName] = useState(defaultName);
  const asking = current.count > 0 && current.unsaved;
  return {
    props: { current, keep, setKeep, name, setName },
    saveAs: asking && keep && name.trim() ? name.trim() : null,
    /** Ticked with no name: nothing can go ahead until there is one. */
    blocked: asking && keep && !name.trim(),
    /** The current list's leads would go without being saved. */
    losing: asking && !keep,
  };
}

function Modal(props: { title: string; role?: 'dialog' | 'alertdialog'; onClose: () => void; onSubmit?: () => void; closeButton?: boolean; children: ReactNode }) {
  const inner = (
    <>
      <header>
        <b>{props.title}</b>
        {props.closeButton && <button type="button" className="btn small" onClick={props.onClose}>Close <kbd>Esc</kbd></button>}
      </header>
      <div className="body">{props.children}</div>
    </>
  );
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), props.onClose())}>
      {props.onSubmit ? (
        <form
          className="modal small-modal"
          role={props.role ?? 'dialog'}
          aria-label={props.title}
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmit!();
          }}
        >
          {inner}
        </form>
      ) : (
        <div className="modal small-modal" role={props.role ?? 'dialog'} aria-label={props.title}>{inner}</div>
      )}
    </div>
  );
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void> | void) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

/**
 * Confirms clearing or replacing the call list. `onConfirm` gets the name to save the current list under,
 * or null to let it go (it's already saved, or you chose not to). Calls and outcomes are never deleted.
 */
export function ClearListDialog(props: {
  title: string;
  confirmLabel: string;
  current: CurrentList;
  defaultName: string;
  onConfirm: (saveAs: string | null) => Promise<void> | void;
  onCancel: () => void;
}) {
  const keep = useKeep(props.current, props.defaultName);
  const [busy, run] = useBusy();
  return (
    <Modal title={props.title} role="alertdialog" onClose={props.onCancel} onSubmit={() => void run(() => props.onConfirm(keep.saveAs))}>
      <KeepCurrent {...keep.props} />
      <p className="help">Calls, outcomes and notes stay with each lead whatever you choose.</p>
      <div className="row">
        <button className={`btn ${keep.losing ? 'danger' : 'primary'}`} type="submit" disabled={busy || keep.blocked}>
          {props.confirmLabel}
        </button>
        <button className="btn" type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </Modal>
  );
}

/** Save as: keeps the call list under a name. A saved list with that name is written over, and it says so. */
export function SaveAsDialog(props: { lists: SavedList[]; defaultName: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(props.defaultName);
  const [busy, run] = useBusy();
  const n = name.trim();
  const same = props.lists.find((l) => l.name.toLowerCase() === n.toLowerCase());
  return (
    <Modal title="Save call list as" onClose={props.onCancel} onSubmit={() => n && void run(() => props.onSave(n))}>
      <label className="field">
        <span>Name</span>
        <input aria-label="Saved list name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      {same && <p className="help">There's already a saved list called <b>{same.name}</b>. Saving replaces it with this list.</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || !n}>{same ? `Replace "${same.name}"` : 'Save'}</button>
        <button className="btn" type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </Modal>
  );
}

/** Load: the saved lists, to make one the call list (saving the current one first if it changed), or delete. */
export function LoadListDialog(props: {
  lists: SavedList[];
  current: CurrentList & { savedId: string | null };
  defaultName: string;
  onLoad: (id: string, saveCurrentAs: string | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const keep = useKeep(props.current, props.defaultName);
  const [busy, run] = useBusy();
  const { savedId, unsaved } = props.current;
  return (
    <Modal title="Load a call list" onClose={props.onClose} closeButton>
      {props.lists.length === 0 ? (
        <p className="muted">No saved lists yet. Use <b>Save as</b> to keep the list you're calling, so you can load it again later.</p>
      ) : (
        <>
          {props.current.count > 0 && (
            <>
              <p className="help" style={{ marginTop: 0 }}>Loading a list takes the place of your current call list.</p>
              <KeepCurrent {...keep.props} />
            </>
          )}
          <ul className="saved-lists">
            {props.lists.map((l) => {
              const isCurrent = l.id === savedId;
              return (
                <li key={l.id}>
                  <span>
                    <b>{l.name}</b>
                    {isCurrent && <span className="badge" style={{ marginLeft: 6 }}>calling now</span>}
                    <span className="sub">{l.to_call} of {l.total} left to call · saved {fmtDateTime(l.saved_at)}</span>
                  </span>
                  <span className="row" style={{ gap: 4 }}>
                    {isCurrent ? (
                      unsaved && (
                        <button
                          className="btn small"
                          disabled={busy}
                          aria-label={`Undo changes to ${l.name}`}
                          title="Load the saved copy again, dropping the changes since you saved"
                          onClick={() => window.confirm(`Go back to the saved copy of "${l.name}"? Changes since you saved it are dropped.`) && void run(() => props.onLoad(l.id, null))}
                        >
                          Undo changes
                        </button>
                      )
                    ) : (
                      <button
                        className="btn small primary"
                        disabled={busy || keep.blocked}
                        aria-label={`Load ${l.name}`}
                        onClick={() => void run(() => props.onLoad(l.id, keep.saveAs))}
                      >
                        Load
                      </button>
                    )}
                    <button
                      className="btn small"
                      disabled={busy}
                      aria-label={`Delete ${l.name}`}
                      onClick={() => window.confirm(`Delete the saved list "${l.name}"? The leads stay in Leads.`) && void run(() => props.onDelete(l.id))}
                    >
                      Delete
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Modal>
  );
}

/**
 * Starts a routine step: its leads go under the call list, or take its place (saving the current list first if it
 * has changes). `extra` shows above the choice, e.g. the blue-appointments reminder for a no-shows step.
 */
export function StartStepDialog(props: {
  name: string;
  count: number;
  mode: 'add' | 'replace';
  current: CurrentList;
  defaultName: string;
  extra?: ReactNode;
  onStart: (mode: 'add' | 'replace', saveCurrentAs: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState(props.current.count ? props.mode : 'add');
  const keep = useKeep(props.current, props.defaultName);
  const [busy, run] = useBusy();
  const replacing = mode === 'replace' && props.current.count > 0;
  const n = `${props.count} lead${props.count === 1 ? '' : 's'}`;
  return (
    <Modal title={`Start: ${props.name}`} onClose={props.onCancel} onSubmit={() => void run(() => props.onStart(mode, replacing ? keep.saveAs : null))}>
      {props.extra}
      <p style={{ marginTop: 0 }}>{props.count ? `${n} to call.` : 'Nothing new to call for this step right now.'}</p>
      {props.current.count > 0 && (
        <div role="radiogroup" aria-label="Where the leads go" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          <label className="choice-inline">
            <input type="radio" name="step-mode" checked={mode === 'add'} onChange={() => setMode('add')} /> Add them under the call list
          </label>
          <label className="choice-inline">
            <input type="radio" name="step-mode" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace the call list ({props.current.count} on it now)
          </label>
        </div>
      )}
      {replacing && <KeepCurrent {...keep.props} />}
      <div className="row">
        <button className={`btn ${replacing && keep.losing ? 'danger' : 'primary'}`} type="submit" disabled={busy || (replacing && keep.blocked)}>
          {replacing ? 'Replace and start' : 'Start'}
        </button>
        <button className="btn" type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </Modal>
  );
}

/**
 * The leads a never-dial tag kept off the call list, and why, each with "Add anyway" (logged on the lead).
 * `onAdded` runs after each one goes on, so the list can reload.
 */
export function SkippedDialog(props: { leads: SkippedLead[]; onClose: () => void; onAdded: () => void; toast: (msg: string, kind?: 'ok' | 'error') => void }) {
  const [left, setLeft] = useState(props.leads);
  const [busy, run] = useBusy();
  const add = (l: SkippedLead) => run(async () => {
    try {
      const r = await api.post<AddResult>('/call-list', { lead_ids: [l.lead_id], override: true });
      props.toast(r.added ? `${l.name} added to the call list anyway` : `${l.name} wasn't added: already on it, or can't be called`);
      const rest = left.filter((y) => y.lead_id !== l.lead_id);
      setLeft(rest);
      props.onAdded();
      // Nothing left to decide: close, rather than leave an empty dialog.
      if (!rest.length) props.onClose();
    } catch (e: any) {
      props.toast(e.message, 'error');
    }
  });
  return (
    <Modal title="Skipped: never dial" onClose={props.onClose} closeButton>
      <p className="help" style={{ marginTop: 0 }}>These leads have a tag marked "never dial" (Automation → Tags), so they were left off the call list. Adding one anyway is noted on the lead.</p>
      {left.length > 0 && (
        <table className="grid">
          <tbody>
            {left.map((l) => (
              <tr key={l.lead_id}>
                <td>{l.name}</td>
                <td className="muted">{l.why}</td>
                <td><button type="button" className="btn small" disabled={busy} onClick={() => void add(l)} aria-label={`Add ${l.name} anyway`}>Add anyway</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
