import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtDateTime, fmtPhone, type LeadDetail } from '../api';
import { useApp } from '../App';
import { LeadSummary, CallHistory, Notes, StatusBadge } from './LeadView';
import { LeadPage } from './LeadPage';
import { EditLead } from './EditLead';
import { isAction, isTyping, keyLabel } from '../shortcuts';

/** One row of the list a lead was opened from, shown on the left so you can move through it. */
export interface ViewerItem {
  id: string;
  name: string;
  status?: string | null;
  phone?: string | null;
  county?: string | null;
}

/**
 * A lead, full screen and laid out like the Calling page: the list you opened it from on the left,
 * the lead in the middle, its PDF page on the right. Nothing here dials or sets an outcome;
 * "Call now" takes the lead to the Calling page for that.
 */
export function LeadViewer({ id, list = [], onClose }: { id: string; list?: ViewerItem[]; onClose: () => void }) {
  const { toast, keys, openLead } = useApp();
  const [current, setCurrent] = useState(id);
  const [items, setItems] = useState<ViewerItem[]>(() => dedupe(list));
  const [d, setD] = useState<LeadDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  const load = useCallback(async () => {
    try {
      const x = await api.get<LeadDetail>(`/leads/${current}`);
      setD(x);
      // Keep the list's badge in step with what you change here.
      if (x.state) setItems((xs) => xs.map((i) => (i.id === x.lead.id ? { ...i, status: x.state!.status } : i)));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [current, toast]);
  useEffect(() => void load(), [load]);

  const idx = items.findIndex((i) => i.id === current);
  const move = (by: number) => {
    if (idx < 0) return;
    const n = items[idx + by];
    if (n) setCurrent(n.id);
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-lead="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  // Capture phase, so Esc closes only this and not a list it was opened from (Reports).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (editing) return;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        return onClose();
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowDown' || isAction(keys, 'list_down', e)) {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp' || isAction(keys, 'list_up', e)) {
        e.preventDefault();
        move(-1);
      } else if (isAction(keys, 'edit', e) && d) {
        e.preventDefault();
        setEditing(true);
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });

  const act = async (action: 'mark_dead' | 'restore') => {
    const reason = action === 'mark_dead' ? window.prompt('Reason for moving to the dead pile (optional):') : 'restored from lead page';
    if (reason === null) return;
    await api.post(`/leads/${current}/actions`, { action, reason });
    toast(action === 'mark_dead' ? 'Moved to dead pile' : 'Restored to queue');
    await load();
  };

  const callNow = () => {
    onClose();
    openLead(current);
  };

  const editKey = keyLabel(keys.actions.edit?.[0] ?? '');
  const showList = items.length > 1;
  const status = d?.state?.status;

  return (
    <div className="lead-viewer" role="dialog" aria-modal="true" aria-label="Lead">
      <div className={`calling${showList ? '' : ' no-list'}`}>
        {showList && (
          <section className="panel" aria-label="Lead list">
            <header>
              <span><b>{idx + 1}</b> of {items.length}</span>
              <span className="help" style={{ marginLeft: 'auto' }}><kbd>↑</kbd><kbd>↓</kbd> move</span>
            </header>
            <div className="body">
              <ul className="queue-list" ref={listRef}>
                {items.map((i) => (
                  <li key={i.id} data-lead={i.id} className={i.id === current ? 'selected' : ''} onClick={() => setCurrent(i.id)}>
                    <span className="name">{i.name || '(no name)'}</span>
                    {i.status ? <StatusBadge status={i.status} /> : <span />}
                    <span className="sub">{[i.phone ? fmtPhone(i.phone) : null, i.county ? `${i.county} Co.` : null].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        <section className="panel" aria-label="Current lead">
          <header>
            <button className="btn small" onClick={onClose}>← Back <kbd>Esc</kbd></button>
            <div className="row" style={{ marginLeft: 'auto' }}>
              {d && (status === 'new' || status === 'retry' || status === 'callback') && (
                <button className="btn small primary" onClick={callNow} title="Open this lead on the Calling page to dial it and set the outcome">Call now</button>
              )}
              {d && (status === 'dead' || status === 'invalid'
                ? <button className="btn small" onClick={() => act('restore')}>Restore to queue</button>
                : <button className="btn small danger" onClick={() => act('mark_dead')}>Move to dead pile</button>)}
            </div>
          </header>
          <div className="body">
            {!d || d.lead.id !== current ? (
              <div className="empty">Loading…</div>
            ) : (
              <>
                <LeadSummary d={d} onEdit={() => setEditing(true)} editKey={editKey} />
                <section className="calls-notes" aria-label="History">
                  <div>
                    <h3>Calls</h3>
                    <CallHistory calls={d.calls} onChange={load} />
                  </div>
                  <div>
                    <h3>Notes</h3>
                    <Notes key={d.lead.id} d={d} onChange={load} />
                  </div>
                </section>
                {d.actions.length > 0 && (
                  <>
                    <h3 style={{ marginTop: 14 }}>Lead actions</h3>
                    <ul className="history">
                      {d.actions.map((a) => <li key={a.id}>{fmtDateTime(a.created_at)} · {a.action.replace('_', ' ')}{a.reason ? ` · ${a.reason}` : ''}</li>)}
                    </ul>
                  </>
                )}
                <p className="help">Source: batch "{d.batch.name}", row {d.import_row?.row_number} of {d.batch.file_name}. Imported {fmtDateTime(d.batch.imported_at)}.</p>
              </>
            )}
          </div>
        </section>

        {d && d.lead.id === current ? <LeadPage d={d} /> : <section className="panel lead-page" aria-label="Lead page" />}
      </div>
      {editing && d && <EditLead d={d} onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await load(); }} />}
    </div>
  );
}

/** A list of calls can name the same lead many times; the viewer lists each lead once. */
function dedupe(list: ViewerItem[]): ViewerItem[] {
  const seen = new Set<string>();
  return list.filter((i) => i.id && !seen.has(i.id) && (seen.add(i.id), true));
}
