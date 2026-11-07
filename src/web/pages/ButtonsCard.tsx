import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { useTags } from '../tags';
import { ConditionEditor } from '../components/ConditionEditor';
import { APPT_RESULT_LABEL } from '../../shared/appointments';
import { outcomeDef } from '../../shared/outcomes';
import {
  BUTTON_BORDERS, BUTTON_COLORS, BUTTON_FILLS, ButtonDef, buttonClass, buttonSide, describeButtonTags,
} from '../../shared/buttons';
import { buttonToPython, pythonToButton, type ButtonNames } from '../../shared/buttonText';
import { RuleTextError } from '../../shared/ruleText';

// Settings → Buttons: the buttons on the Calling screen. Each counts as an outcome (what Reports and the funnel see),
// can show only when a condition is true, has a look, and can add or take off tags. Every outcome has its own button,
// which you can rename or hide; you can add more that count as any outcome.

/** What an outcome counts as, in a few words, so a renamed one still says what it does. */
function outcomeMeaning(code: string): string {
  const d = outcomeDef(code);
  if (!d) return '';
  const parts = [
    d.pickup && 'a pickup',
    d.apptSet && 'an appt set',
    d.callback && 'a callback (asks for a day)',
    d.group === 'invalid' && 'a bad number',
    d.marksDead && 'the dead pile',
    d.apptResult && `appointment: ${APPT_RESULT_LABEL[d.apptResult].toLowerCase()}`,
  ].filter(Boolean);
  return parts.length ? `Counts as ${parts.join(', ')}` : 'Not reached';
}

/** A button with nothing changed but its name and "shown". */
const plain = (b: ButtonDef) =>
  !b.show_when && b.color === 'default' && b.fill === 'outline' && b.border === 'solid' && !b.confirm && !b.tooltip && !b.add_tags.length && !b.remove_tags.length;

const COLOR_NAMES: Record<string, string> = { default: 'Plain' };
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function ButtonsCard() {
  const { meta, reloadMeta, toast } = useApp();
  const { tags, tagName } = useTags();
  const [draft, setDraft] = useState<ButtonDef[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [conditionFor, setConditionFor] = useState<string | null>(null);
  // The Python view of the button being edited, and its mistake while it has one (the button keeps the last text that read right).
  const [text, setText] = useState<{ id: string; src: string; error: { line: number; message: string } | null } | null>(null);
  const saved = meta?.buttons ?? [];
  const list: ButtonDef[] = draft ?? saved;
  const outcomes = meta?.outcome_codes ?? [];
  const outcomeLabel = (code: string) => outcomes.find((o) => o.code === code)?.label ?? outcomeDef(code)?.label ?? code;
  const own = (b: ButtonDef) => b.id === b.outcome;
  const names: ButtonNames = {
    tag: tagName,
    tagId: (n) => tags.find((t) => t.name.toLowerCase() === n.toLowerCase())?.id,
    outcome: (c) => outcomes.find((o) => o.code === c)?.label,
    outcomeCode: (n) => outcomes.find((o) => o.code === n || o.label.toLowerCase() === n.toLowerCase())?.code,
  };
  const open = (id: string | null) => { setEditing(id); setText(null); setConditionFor(null); };
  const readText = (b: ButtonDef, src: string) => {
    try {
      const next = pythonToButton(src, b, names);
      setDraft(list.map((x) => (x.id === b.id ? next : x)));
      setText({ id: b.id, src, error: null });
    } catch (e) {
      if (!(e instanceof RuleTextError)) throw e;
      setText({ id: b.id, src, error: { line: e.line, message: e.message } });
    }
  };

  const change = (id: string, patch: Partial<ButtonDef>) => setDraft(list.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  /** Moves a button up or down past the next one on its side. */
  const move = (id: string, by: -1 | 1) => {
    const i = list.findIndex((b) => b.id === id);
    const side = buttonSide(list[i]!);
    let j = i + by;
    while (j >= 0 && j < list.length && buttonSide(list[j]!) !== side) j += by;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setDraft(next);
  };
  const add = (side: 'first_call' | 'appointment') => {
    const first = outcomes.find((o) => o.kind === side);
    if (!first) return;
    const id = `b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setDraft([...list, ButtonDef.parse({ id, outcome: first.code, label: 'New button' })]);
    open(id);
  };
  const reset = (b: ButtonDef) => {
    const def = outcomeDef(b.outcome)!;
    setDraft(list.map((x) => (x.id === b.id ? ButtonDef.parse({ id: b.id, outcome: b.outcome, label: def.label, hidden: !def.offered }) : x)));
  };
  const save = async () => {
    try {
      // Parsing drops what the server adds (side, own, default key).
      await api.put('/buttons', { buttons: list.map((b) => ButtonDef.parse(b)) });
      await reloadMeta();
      setDraft(null);
      open(null);
      toast('Buttons saved');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const TagList = ({ b, field, what }: { b: ButtonDef; field: 'add_tags' | 'remove_tags'; what: string }) => (
    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
      <span>{what}</span>
      {b[field].map((t) => (
        <span key={t} className="chip">{tagName(t) ?? 'a deleted tag'}<button type="button" aria-label={`${what} ${tagName(t) ?? 'tag'}: remove`} onClick={() => change(b.id, { [field]: b[field].filter((x) => x !== t) })}>×</button></span>
      ))}
      {b[field].length < 10 && (
        <select value="" aria-label={`${b.label}: ${what.toLowerCase()}`} onChange={(e) => e.target.value && change(b.id, { [field]: [...b[field], e.target.value] })}>
          <option value="">+ tag</option>
          {tags.filter((t) => !b.add_tags.includes(t.id) && !b.remove_tags.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
    </div>
  );

  const details = (b: ButtonDef) => {
    const mine = text?.id === b.id ? text : null;
    return (
    <div className="button-details">
      <div className="row" style={{ gap: 8 }}>
        <div className="tabs small" role="tablist" aria-label={`${b.label} view`}>
          <button type="button" role="tab" aria-selected={!mine} className={!mine ? 'active' : ''} disabled={!!mine?.error} onClick={() => setText(null)}>Form</button>
          <button type="button" role="tab" aria-selected={!!mine} className={mine ? 'active' : ''} onClick={() => setText({ id: b.id, src: buttonToPython(b, names), error: null })}>Python</button>
        </div>
        {mine?.error && <span className="error" role="alert" aria-label="Python mistake">Line {mine.error.line}: {mine.error.message}</span>}
      </div>
      {mine ? (
        <label className="field">
          <span className="help" style={{ margin: 0 }}>
            The same button as Python: <code>@button(...)</code> says what it counts as (<code>counts_as</code>), when it shows (<code>shows_when</code>, a condition)
            and how it looks (<code>color</code>, <code>fill</code>, <code>border</code>, <code>tooltip</code>, <code>confirm</code>). <code>@hidden</code> keeps it off
            the Calling screen. The docstring is its name, and each line is <code>add_tag("...")</code> or <code>remove_tag("...")</code>.
          </span>
          <textarea value={mine.src} rows={Math.max(6, mine.src.split('\n').length + 2)} spellCheck={false} style={{ width: '100%', fontFamily: 'var(--mono, monospace)' }}
            aria-label="Button in Python" onChange={(e) => readText(b, e.target.value)} />
        </label>
      ) : (<>
      {!own(b) && (
        <label className="row" style={{ gap: 6 }}>
          Counts as
          <select value={b.outcome} aria-label={`${b.label}: counts as`} onChange={(e) => change(b.id, { outcome: e.target.value })}>
            {outcomes.map((o) => <option key={o.code} value={o.code}>{o.kind === 'appointment' ? 'Appointment: ' : 'First call: '}{o.label}</option>)}
          </select>
        </label>
      )}
      <div className="row" style={{ gap: 6 }}>
        Shows {b.show_when ? <>when <code aria-label={`${b.label}: show when`}>{b.show_when}</code></> : 'for every lead'}
        <button type="button" className="btn small" onClick={() => setConditionFor(b.id)}>{b.show_when ? 'Edit' : 'Only when…'}</button>
        {b.show_when && <button type="button" className="btn small" onClick={() => change(b.id, { show_when: '' })}>Always</button>}
      </div>
      {conditionFor === b.id && (
        <ConditionEditor value={b.show_when} onApply={(c) => { change(b.id, { show_when: c }); setConditionFor(null); }} onCancel={() => setConditionFor(null)} />
      )}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        Look
        <select value={b.color} aria-label={`${b.label}: color`} onChange={(e) => change(b.id, { color: e.target.value as ButtonDef['color'] })}>
          {BUTTON_COLORS.map((c) => <option key={c} value={c}>{COLOR_NAMES[c] ?? cap(c)}</option>)}
        </select>
        <select value={b.fill} aria-label={`${b.label}: fill`} disabled={b.color === 'default'} onChange={(e) => change(b.id, { fill: e.target.value as ButtonDef['fill'] })}>
          {BUTTON_FILLS.map((f) => <option key={f} value={f}>{f === 'filled' ? 'Filled' : 'Outlined'}</option>)}
        </select>
        <select value={b.border} aria-label={`${b.label}: border`} onChange={(e) => change(b.id, { border: e.target.value as ButtonDef['border'] })}>
          {BUTTON_BORDERS.map((x) => <option key={x} value={x}>{cap(x)} border</option>)}
        </select>
        <span className="outcomes" style={{ display: 'inline-block', margin: 0 }}><button type="button" className={buttonClass(b)} title={b.tooltip || undefined}>{b.label}</button></span>
      </div>
      <label className="row" style={{ gap: 6 }}>
        Tooltip <input value={b.tooltip} maxLength={200} style={{ width: 320 }} aria-label={`${b.label}: tooltip`} onChange={(e) => change(b.id, { tooltip: e.target.value })} />
      </label>
      <label className="row" style={{ gap: 4 }}>
        <input type="checkbox" checked={b.confirm} onChange={(e) => change(b.id, { confirm: e.target.checked })} /> Ask "are you sure?" first
      </label>
      <TagList b={b} field="add_tags" what="Adds" />
      <TagList b={b} field="remove_tags" what="Takes off" />
      {!tags.length && <span className="help">Make tags under Tags to have a button add them.</span>}
      </>)}
    </div>
    );
  };

  return (
    <div className="card" id="outcomes">
      <h2>Buttons</h2>
      <p className="help">
        The buttons on the Calling screen. Each one counts as an outcome (pickup, appt set, sale...), which is what your numbers see.
        A button can show only for some leads, look how you like, and add or take off tags. Rename an outcome's own button and older calls
        show the new name; a button you add keeps its name on the calls saved with it. Keys are under Keyboard shortcuts.
      </p>
      {(['first_call', 'appointment'] as const).map((side) => (
        <div key={side}>
          <h3>{side === 'appointment' ? 'Appointment side' : 'First call side'}</h3>
          <table className="grid" style={{ maxWidth: 900 }}>
            <thead><tr><th>Name</th><th>Button</th><th>What it does</th><th></th></tr></thead>
            <tbody>
              {list.filter((b) => buttonSide(b) === side).map((b) => {
                const def = outcomeDef(b.outcome);
                const isDefault = own(b) && !!def && b.label === def.label && b.hidden === !def.offered && plain(b);
                const does = [
                  own(b) ? outcomeMeaning(b.outcome) : `Counts as ${outcomeLabel(b.outcome)}`,
                  describeButtonTags(b, tagName),
                  b.show_when && 'only for some leads',
                ].filter(Boolean).join('; ');
                return [
                  <tr key={b.id}>
                    <td><input value={b.label} maxLength={40} onChange={(e) => change(b.id, { label: e.target.value })} aria-label={`Name for ${own(b) ? def?.label ?? b.id : b.label}`} style={{ width: 220 }} /></td>
                    <td><input type="checkbox" checked={!b.hidden} onChange={(e) => change(b.id, { hidden: !e.target.checked })} aria-label={`Show a button for ${b.label}`} /></td>
                    <td className="muted small">{does}</td>
                    <td><div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      <button type="button" className="btn small" aria-label={`Move ${b.label} up`} onClick={() => move(b.id, -1)}>↑</button>
                      <button type="button" className="btn small" aria-label={`Move ${b.label} down`} onClick={() => move(b.id, 1)}>↓</button>
                      <button type="button" className="btn small" aria-expanded={editing === b.id} onClick={() => open(editing === b.id ? null : b.id)}>{editing === b.id ? 'Close' : 'More'}</button>
                      {own(b) && !isDefault && <button type="button" className="btn small" onClick={() => reset(b)}>Reset</button>}
                      {!own(b) && <button type="button" className="btn small" onClick={() => setDraft(list.filter((x) => x.id !== b.id))}>Delete</button>}
                    </div></td>
                  </tr>,
                  editing === b.id && <tr key={`${b.id}-more`}><td colSpan={4}>{details(b)}</td></tr>,
                ];
              })}
            </tbody>
          </table>
          <button type="button" className="btn small" style={{ marginTop: 4 }} onClick={() => add(side)}>+ Add a button</button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={!draft || !!text?.error} onClick={() => void save()}>Save buttons</button>
        {draft && <button className="btn" onClick={() => { setDraft(null); open(null); }}>Cancel</button>}
      </div>
    </div>
  );
}
