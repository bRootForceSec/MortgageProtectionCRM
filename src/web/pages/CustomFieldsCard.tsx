import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { useCustomFields } from '../customFields';
import { CUSTOM_FIELD_TYPES, type CustomField, type CustomFieldType } from '../../shared/customFields';
import { FORMULA_FUNCTIONS, FORMULA_VALUES, type FormulaPreview } from '../../shared/formula';

// Settings → Your fields: the fields you add to every lead. Values are typed on the lead (Edit), shown with its
// details, and the Leads page and routine steps can filter on them. A formula field is worked out from the lead (a
// lead score): you write the formula here and see what it gives your leads as you type.

interface Draft { label: string; type: CustomFieldType; options: string; formula: string }

const toDraft = (f: CustomField): Draft => ({ label: f.label, type: f.type, options: f.options.join(', '), formula: f.formula ?? '' });
const toBody = (d: Draft) => ({
  label: d.label.trim(),
  type: d.type,
  ...(d.type === 'choice' ? { options: d.options.split(',').map((o) => o.trim()).filter(Boolean) } : {}),
  ...(d.type === 'formula' ? { formula: d.formula } : {}),
});
const EMPTY: Draft = { label: '', type: 'text', options: '', formula: '' };

const RESULT_WORDS = { number: 'a number', text: 'text', yes_no: 'yes or no' } as const;

/** The formula box: what you can use, and what the formula gives your leads now (or its mistake), as you type. */
function FormulaEditor(props: { name: string; fieldId: string | null; value: string; onChange: (v: string) => void }) {
  const [preview, setPreview] = useState<FormulaPreview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const { value, fieldId } = props;
  useEffect(() => {
    if (!value.trim()) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api.post<FormulaPreview>('/custom-fields/formula-preview', { formula: value, field_id: fieldId }).then(
        (p) => { if (live) { setPreview(p); setFailed(null); } },
        (e: Error) => { if (live) setFailed(e.message); },
      );
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [value, fieldId]);
  /** Puts text in at the cursor. */
  const insert = (text: string) => {
    const el = box.current;
    const at = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    props.onChange(value.slice(0, at) + text + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + text.length, at + text.length);
    });
  };
  const p = preview;
  const show = (v: string | null) => (v == null ? '(blank)' : p?.result === 'yes_no' ? (v === 'yes' ? 'Yes' : 'No') : v);
  return (
    <div className="formula">
      <textarea
        ref={box}
        value={value}
        rows={3}
        maxLength={2000}
        spellCheck={false}
        placeholder={'if(age >= 60, 20, 0) + if(has_tag("Hot"), 30, 0) - attempts * 2'}
        aria-label={`${props.name} formula`}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <div className="formula-check" role="status" aria-label={`Check of ${props.name}`}>
        {failed ? <span className="error">Couldn't check the formula: {failed}</span>
          : !p ? <span className="muted">Write a formula; what it gives your leads shows here.</span>
          : p.error ? <span className="error">{p.at != null ? `At character ${p.at + 1}: ` : ''}{p.error}</span>
          : (
            <>
              <span>
                Works out to {RESULT_WORDS[p.result!]} for {p.filled} of {p.total} lead{p.total === 1 ? '' : 's'}
                {p.result === 'number' && p.low != null ? ` · from ${p.low} to ${p.high}, average ${p.average}` : ''}.
              </span>
              {p.samples.length > 0 && <span className="muted"> For example: {p.samples.map((s) => `${s.name} ${show(s.value)}`).join(', ')}.</span>}
            </>
          )}
      </div>
      <details>
        <summary>What you can use</summary>
        <p className="help">
          Numbers, "text", yes and no, your own fields in square brackets like [Mortgage payment], + − × ÷ as + - * /, compare with = != &lt; &lt;= &gt; &gt;=,
          and join tests with and, or, not. A blank value makes a sum blank: wrap it in ifblank(…, 0). Click one to put it in.
        </p>
        <div className="formula-help">
          {FORMULA_VALUES.map((v) => <button key={v.name} type="button" className="chip" title={v.help} onClick={() => insert(v.name)}>{v.name}</button>)}
          {FORMULA_FUNCTIONS.map((f) => <button key={f.name} type="button" className="chip" title={f.help} onClick={() => insert(`${f.name}(`)}>{f.usage}</button>)}
        </div>
      </details>
    </div>
  );
}

export function CustomFieldsCard() {
  const { toast } = useApp();
  const { fields, setFields, reload } = useCustomFields();
  const [edit, setEdit] = useState<Record<string, Draft>>({});
  const [add, setAdd] = useState<Draft>(EMPTY);
  const run = async (what: () => Promise<unknown>, done: string) => {
    try {
      await what();
      await reload();
      toast(done);
      return true;
    } catch (e: any) {
      toast(e.message, 'error');
      return false;
    }
  };
  const row = (d: Draft, set: (d: Draft) => void, name: string, locked: boolean) => (
    <>
      <td><input value={d.label} maxLength={60} placeholder="Field name" aria-label={`${name} name`} onChange={(e) => set({ ...d, label: e.target.value })} style={{ width: '100%' }} /></td>
      <td>
        <select value={d.type} disabled={locked} aria-label={`${name} kind`} title={locked ? 'Leads have values in this field, so its kind stays' : undefined} onChange={(e) => set({ ...d, type: e.target.value as CustomFieldType })}>
          {CUSTOM_FIELD_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </td>
      <td>
        {d.type === 'choice' && (
          <input value={d.options} placeholder="Choices, split by commas" aria-label={`${name} choices`} onChange={(e) => set({ ...d, options: e.target.value })} style={{ width: '100%' }} />
        )}
        {d.type === 'formula' && <span className="muted">Formula below</span>}
      </td>
    </>
  );
  const formulaRow = (d: Draft, set: (d: Draft) => void, name: string, fieldId: string | null) =>
    d.type === 'formula' && (
      <tr className="formula-row">
        <td colSpan={5}><FormulaEditor name={name} fieldId={fieldId} value={d.formula} onChange={(formula) => set({ ...d, formula })} /></td>
      </tr>
    );
  return (
    <div className="card" id="custom-fields">
      <h2>Your fields</h2>
      <p className="help">
        Fields you add to every lead, such as a spouse's name, the mortgage payment or who decides. Fill them in with Edit on a lead; they show with its
        details. Filter on them on Leads (and save that as a routine step). A formula field, like a lead score, is worked out from the lead and
        stays up to date by itself: sort Leads by it, filter on a range, and use it in rules.
      </p>
      <table className="grid" style={{ maxWidth: 860 }}>
        <thead><tr><th>Name</th><th>Kind</th><th>Choices</th><th>Leads</th><th></th></tr></thead>
        <tbody>
          {fields.map((f, i) => {
            const d = edit[f.id] ?? toDraft(f);
            const dirty = !!edit[f.id] && JSON.stringify(edit[f.id]) !== JSON.stringify(toDraft(f));
            const set = (n: Draft) => setEdit({ ...edit, [f.id]: n });
            return (
              <Fragment key={f.id}>
              <tr>
                {row(d, set, `Field ${f.label}`, f.leads > 0)}
                <td>{f.type === 'formula' ? (f.result ? <span className="muted" title="Worked out for every lead">all</span> : <span className="error" title="Fix its formula">mistake</span>) : f.leads}</td>
                <td className="nowrap">
                  {dirty && (
                    <button className="btn small primary" onClick={async () => {
                      if (await run(() => api.put(`/custom-fields/${f.id}`, toBody(d)), 'Field saved')) setEdit((e) => { const n = { ...e }; delete n[f.id]; return n; });
                    }}>Save</button>
                  )}{' '}
                  <button className="btn small" aria-label={`Move ${f.label} up`} disabled={i === 0} onClick={() => void api.post<CustomField[]>(`/custom-fields/${f.id}/move`, { by: -1 }).then(setFields, (e: Error) => toast(e.message, 'error'))}>↑</button>
                  <button className="btn small" aria-label={`Move ${f.label} down`} disabled={i === fields.length - 1} onClick={() => void api.post<CustomField[]>(`/custom-fields/${f.id}/move`, { by: 1 }).then(setFields, (e: Error) => toast(e.message, 'error'))}>↓</button>{' '}
                  <button className="btn small" onClick={() => {
                    if (!window.confirm(`Delete the field "${f.label}"?${f.leads ? ` Its value on ${f.leads} lead${f.leads === 1 ? '' : 's'} goes too.` : ''}`)) return;
                    void run(() => api.del(`/custom-fields/${f.id}`), `Deleted "${f.label}"`);
                  }}>Delete</button>
                </td>
              </tr>
              {formulaRow(d, set, `Field ${f.label}`, f.id)}
              </Fragment>
            );
          })}
          <tr>
            {row(add, setAdd, 'New field', false)}
            <td></td>
            <td>
              <button className="btn small" disabled={!add.label.trim()} onClick={async () => {
                if (await run(() => api.post('/custom-fields', toBody(add)), `Added "${add.label.trim()}"`)) setAdd(EMPTY);
              }}>Add field</button>
            </td>
          </tr>
          {formulaRow(add, setAdd, 'New field', null)}
        </tbody>
      </table>
    </div>
  );
}
