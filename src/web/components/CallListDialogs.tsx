import { useState } from 'react';
import { fmtDateTime, type CallListItem, type SavedList } from '../api';

// Dialogs for swapping call lists: clear or replace the list (keeping the old one as a saved list
// if you want it back), and the saved lists you can load again.

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

/** Asks whether to keep the current list as a saved list before it's cleared. Ticked by default. */
function KeepCurrent(props: { count: number; keep: boolean; setKeep: (v: boolean) => void; name: string; setName: (v: string) => void }) {
  if (!props.count) return null;
  return (
    <div className="keep-list">
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" checked={props.keep} onChange={(e) => props.setKeep(e.target.checked)} />
        Keep the {props.count} lead{props.count === 1 ? '' : 's'} on it as a saved list, to call later
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

/**
 * Confirms clearing or replacing the call list. `onConfirm` gets the name to save the current list under,
 * or null to throw it away. Calls and outcomes are never deleted either way.
 */
export function ClearListDialog(props: {
  title: string;
  confirmLabel: string;
  count: number;
  defaultName: string;
  onConfirm: (saveAs: string | null) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [keep, setKeep] = useState(true);
  const [name, setName] = useState(props.defaultName);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await props.onConfirm(keep && name.trim() ? name.trim() : null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), props.onCancel())}>
      <form
        className="modal small-modal"
        role="alertdialog"
        aria-label={props.title}
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <header><b>{props.title}</b></header>
        <div className="body">
          <KeepCurrent count={props.count} keep={keep} setKeep={setKeep} name={name} setName={setName} />
          <p className="help">Calls, outcomes and notes stay with each lead whatever you choose.</p>
          <div className="row">
            <button className={`btn ${keep || !props.count ? 'primary' : 'danger'}`} type="submit" disabled={busy || (keep && !!props.count && !name.trim())}>
              {props.confirmLabel}
            </button>
            <button className="btn" type="button" onClick={props.onCancel}>Cancel</button>
          </div>
        </div>
      </form>
    </div>
  );
}

/** The saved lists: load one back (putting the current list away first) or delete it. */
export function SavedListsDialog(props: {
  lists: SavedList[];
  count: number;
  defaultName: string;
  onLoad: (id: string, saveCurrentAs: string | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [keep, setKeep] = useState(true);
  const [name, setName] = useState(props.defaultName);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), props.onClose())}>
      <div className="modal small-modal" role="dialog" aria-label="Saved lists">
        <header><b>Saved lists</b><button className="btn small" onClick={props.onClose}>Close <kbd>Esc</kbd></button></header>
        <div className="body">
          {props.lists.length === 0 ? (
            <p className="muted">No saved lists yet. When you clear or replace your call list, you can keep it here to call later.</p>
          ) : (
            <>
              {props.count > 0 && (
                <>
                  <p className="help" style={{ marginTop: 0 }}>Loading a list takes the place of your current call list.</p>
                  <KeepCurrent count={props.count} keep={keep} setKeep={setKeep} name={name} setName={setName} />
                </>
              )}
              <ul className="saved-lists">
                {props.lists.map((l) => (
                  <li key={l.id}>
                    <span>
                      <b>{l.name}</b>
                      <span className="sub">{l.to_call} of {l.total} left to call · saved {fmtDateTime(l.saved_at)}</span>
                    </span>
                    <span className="row" style={{ gap: 4 }}>
                      <button
                        className="btn small primary"
                        disabled={busy || (keep && props.count > 0 && !name.trim())}
                        aria-label={`Load ${l.name}`}
                        onClick={() => void run(() => props.onLoad(l.id, keep && props.count > 0 ? name.trim() : null))}
                      >
                        Load
                      </button>
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
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
