import { useCallback, useEffect, useState } from 'react';
import { api, newKey, type Tag } from '../api';
import { useApp } from '../App';
import { type Rule, type TagGroup, type TagShortcuts } from '../../shared/rules';

// Tag shortcuts in Automation → Tags. Each is only a way to write rules: the rules show here, under the shortcut, and in
// Automation → Rules, where they can be previewed and run but changed only here.

const NONE: TagShortcuts = { expiry: [], groups: [] };

/** Sent when shortcuts change the rules, so Automation → Rules, on the same screen, loads them again. */
export const RULES_CHANGED = 'mpcrm:rules-changed';

/** Your tag shortcuts and the rules they write, with a save that keeps both up to date. */
export function useTagShortcuts() {
  const { toast } = useApp();
  const [shortcuts, setShortcuts] = useState<TagShortcuts>(NONE);
  const [rules, setRules] = useState<Rule[]>([]);
  const load = useCallback(async () => {
    try {
      const [sc, r] = await Promise.all([api.get<TagShortcuts>('/tag-shortcuts'), api.get<{ rules: Rule[] }>('/rules')]);
      setShortcuts(sc);
      setRules(r.rules.filter((x) => x.made_by));
    } catch (e) {
      toast(`Couldn't load tag shortcuts: ${(e as Error).message}`, 'error');
    }
  }, [toast]);
  useEffect(() => void load(), [load]);
  const save = async (next: TagShortcuts): Promise<boolean> => {
    try {
      const r = await api.put<{ shortcuts: TagShortcuts; rules: Rule[] }>('/tag-shortcuts', next);
      setShortcuts(r.shortcuts);
      setRules(r.rules);
      window.dispatchEvent(new Event(RULES_CHANGED));
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };
  return { shortcuts, rules, save, load };
}

/** "Takes itself off" for one tag: never, at the end of the day, or after so many hours. */
export function ExpiryPicker({ tag, sc }: { tag: Tag; sc: ReturnType<typeof useTagShortcuts> }) {
  const cur = sc.shortcuts.expiry.find((x) => x.tag_id === tag.id);
  const [hours, setHours] = useState(String(cur?.hours ?? 24));
  const set = (h: number | null | undefined) => {
    const rest = sc.shortcuts.expiry.filter((x) => x.tag_id !== tag.id);
    void sc.save({ ...sc.shortcuts, expiry: h === undefined ? rest : [...rest, { tag_id: tag.id, hours: h }] });
  };
  const mode = !cur ? '' : cur.hours == null ? 'day' : 'hours';
  const rule = sc.rules.find((r) => r.made_by?.kind === 'expiry' && r.made_by.tag_id === tag.id);
  return (
    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }} title={rule && rule.trigger.kind === 'becomes_true' ? `The rule it writes: when ${rule.trigger.condition}, take "${tag.name}" off` : undefined}>
      <select value={mode} aria-label={`When ${tag.name} comes off by itself`} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value === 'day' ? null : Math.max(1, Number(hours) || 24))}>
        <option value="">Stays on</option>
        <option value="day">Off at the end of the day</option>
        <option value="hours">Off after some hours</option>
      </select>
      {mode === 'hours' && (
        <label className="row" style={{ gap: 4 }}>
          <input type="number" min={1} step={1} value={hours} style={{ width: 70 }} aria-label={`Hours before ${tag.name} comes off`}
            onChange={(e) => setHours(e.target.value)} onBlur={() => { const h = Math.max(1, Math.trunc(Number(hours) || 24)); if (h !== cur?.hours) set(h); }} /> hours
        </label>
      )}
    </div>
  );
}

/** Groups where only one tag can be on a lead at a time: putting one on takes the others off. */
export function TagGroups({ tags, sc }: { tags: Tag[]; sc: ReturnType<typeof useTagShortcuts> }) {
  const [editing, setEditing] = useState<TagGroup | null>(null);
  const name = (id: string) => tags.find((t) => t.id === id)?.name ?? 'a deleted tag';
  const saveGroup = async (g: TagGroup) => {
    const groups = sc.shortcuts.groups.some((x) => x.id === g.id) ? sc.shortcuts.groups.map((x) => (x.id === g.id ? g : x)) : [...sc.shortcuts.groups, g];
    if (await sc.save({ ...sc.shortcuts, groups })) setEditing(null);
  };
  return (
    <div style={{ marginTop: 12 }} aria-label="Only one at a time">
      <h3 style={{ margin: '0 0 4px' }}>Only one at a time</h3>
      <p className="help">
        A group of tags a lead can have only one of, like No show, Sat, Presentation and Sold. Putting one on takes the others off. Each group writes one
        rule per tag, shown under it and in Automation → Rules.
      </p>
      {sc.shortcuts.groups.map((g) => (
        <div key={g.id} className="rule" aria-label={`Group ${g.name}`} style={{ marginBottom: 6 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>{g.name}</b>
            <span className="row" style={{ gap: 4 }}>
              <button className="btn small" onClick={() => setEditing(g)}>Edit</button>
              <button className="btn small" onClick={() => { if (window.confirm(`Delete the group "${g.name}"? Its rules go with it; tags on leads stay.`)) void sc.save({ ...sc.shortcuts, groups: sc.shortcuts.groups.filter((x) => x.id !== g.id) }); }}>Delete</button>
            </span>
          </div>
          <ul className="help" style={{ margin: '4px 0 0 18px' }}>
            {g.tag_ids.map((id) => <li key={id}>Putting on "{name(id)}" takes off {g.tag_ids.filter((o) => o !== id).map((o) => `"${name(o)}"`).join(', ')}</li>)}
          </ul>
        </div>
      ))}
      {editing ? (
        <GroupEditor group={editing} tags={tags} onSave={saveGroup} onCancel={() => setEditing(null)} />
      ) : (
        <button className="btn small" disabled={tags.length < 2} onClick={() => setEditing({ id: newKey(), name: '', tag_ids: [] })}>+ Group</button>
      )}
    </div>
  );
}

function GroupEditor(props: { group: TagGroup; tags: Tag[]; onSave: (g: TagGroup) => Promise<void>; onCancel: () => void }) {
  const [g, setG] = useState(props.group);
  const ok = g.name.trim() && g.tag_ids.length >= 2 && g.tag_ids.length <= 11;
  return (
    <div className="rule" role="group" aria-label="Edit group">
      <input value={g.name} maxLength={60} placeholder="Group name, like Appointment result" aria-label="Group name" onChange={(e) => setG({ ...g, name: e.target.value })} />
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, margin: '6px 0' }}>
        {props.tags.map((t) => (
          <label key={t.id} className="row" style={{ gap: 2 }}>
            <input type="checkbox" checked={g.tag_ids.includes(t.id)} onChange={(e) => setG({ ...g, tag_ids: e.target.checked ? [...g.tag_ids, t.id] : g.tag_ids.filter((x) => x !== t.id) })} /> {t.name}
          </label>
        ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn small primary" disabled={!ok} onClick={() => void props.onSave({ ...g, name: g.name.trim() })}>Save group</button>
        <button className="btn small" onClick={props.onCancel}>Cancel</button>
        <span className="help" style={{ margin: 0 }}>Pick 2 to 11 tags.</span>
      </div>
    </div>
  );
}

/** Shown on a rule a shortcut wrote, in Automation → Rules. */
export function madeByText(r: Rule): string | null {
  if (!r.made_by) return null;
  return r.made_by.kind === 'expiry' ? 'Written by a tag that comes off by itself: change it in Automation → Tags.' : `Written by the group "${r.made_by.name}": change it in Automation → Tags.`;
}

