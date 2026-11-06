import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { useCustomFields } from '../customFields';
import { CUSTOM_FIELD_TYPES, type CustomField, type CustomFieldType } from '../../shared/customFields';

// Settings → Your fields: the fields you add to every lead. Values are typed on the lead (Edit), shown with its
// details, and the Leads page and routine steps can filter on them.

interface Draft { label: string; type: CustomFieldType; options: string }

const toDraft = (f: CustomField): Draft => ({ label: f.label, type: f.type, options: f.options.join(', ') });
const toBody = (d: Draft) => ({
  label: d.label.trim(),
  type: d.type,
  ...(d.type === 'choice' ? { options: d.options.split(',').map((o) => o.trim()).filter(Boolean) } : {}),
});

export function CustomFieldsCard() {
  const { toast } = useApp();
  const { fields, setFields, reload } = useCustomFields();
  const [edit, setEdit] = useState<Record<string, Draft>>({});
  const [add, setAdd] = useState<Draft>({ label: '', type: 'text', options: '' });
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
      </td>
    </>
  );
  return (
    <div className="card" id="custom-fields">
      <h2>Your fields</h2>
      <p className="help">
        Fields you add to every lead, such as a spouse's name, the mortgage payment or who decides. Fill them in with Edit on a lead; they show with its
        details. Filter on them on Leads (and save that as a routine step).
      </p>
      <table className="grid" style={{ maxWidth: 860 }}>
        <thead><tr><th>Name</th><th>Kind</th><th>Choices</th><th>Leads</th><th></th></tr></thead>
        <tbody>
          {fields.map((f, i) => {
            const d = edit[f.id] ?? toDraft(f);
            const dirty = !!edit[f.id] && JSON.stringify(edit[f.id]) !== JSON.stringify(toDraft(f));
            return (
              <tr key={f.id}>
                {row(d, (n) => setEdit({ ...edit, [f.id]: n }), `Field ${f.label}`, f.leads > 0)}
                <td>{f.leads}</td>
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
            );
          })}
          <tr>
            {row(add, setAdd, 'New field', false)}
            <td></td>
            <td>
              <button className="btn small" disabled={!add.label.trim()} onClick={async () => {
                if (await run(() => api.post('/custom-fields', toBody(add)), `Added "${add.label.trim()}"`)) setAdd({ label: '', type: 'text', options: '' });
              }}>Add field</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
