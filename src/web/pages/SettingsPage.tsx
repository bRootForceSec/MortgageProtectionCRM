import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { useLeadTypes } from './ImportPage';

// Settings: which AI reads scanned lead pages, lead types and prices, and the area codes each county is called under.

interface AiSettings {
  provider: 'claude_code' | 'anthropic_api' | 'openai_compatible' | 'off';
  claude_code: { command: string; model: string };
  anthropic_api: { model: string };
  openai_compatible: { base_url: string; model: string };
  keys: { anthropic_api_key: boolean; openai_api_key: boolean };
}

interface County {
  county_key: string;
  name: string;
  state: string;
  leads: number;
  workable: number;
  area_codes: string[];
  suggested: { area_code: string; leads: number }[];
}

export function SettingsPage() {
  return (
    <>
      <AiCard />
      <LeadTypesCard />
      <CountiesCard />
    </>
  );
}

function AiCard() {
  const { toast } = useApp();
  const [s, setS] = useState<AiSettings | null>(null);
  const [key, setKey] = useState('');
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    api.get<AiSettings>('/settings/ai').then(setS).catch((e) => toast(e.message, 'error'));
  }, [toast]);
  if (!s) return null;
  const save = async (next: AiSettings) => {
    setS(next);
    setTest(null);
    try {
      const { keys, ...body } = next;
      setS(await api.put<AiSettings>('/settings/ai', body));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const keyName = s.provider === 'anthropic_api' ? 'anthropic_api_key' : 'openai_api_key';
  const saveKey = async (value: string | null) => {
    try {
      setS(await api.put<AiSettings>('/settings/ai/key', { name: keyName, value }));
      setKey('');
      toast(value ? 'Key saved on this computer' : 'Key removed');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const opt = (v: AiSettings['provider'], label: string, help: string) => (
    <label className="choice">
      <input type="radio" name="provider" checked={s.provider === v} onChange={() => save({ ...s, provider: v })} />
      <span><b>{label}</b><br /><span className="help">{help}</span></span>
    </label>
  );
  return (
    <div className="card">
      <h2>AI for scanned lead pages</h2>
      <p className="help">Typed pages are read without AI. Only pages with no text (scans, mailer cards) are sent to the AI, one page at a time.</p>
      <div className="choices">
        {opt('claude_code', 'Claude, with your Claude account', 'Uses the Claude Code app on this computer. No API key needed. A page costs a fraction of a cent of your usage.')}
        {opt('anthropic_api', 'Claude API key', 'Pay per page with your own Anthropic API key.')}
        {opt('openai_compatible', 'Local model or another provider', 'Ollama, LM Studio, or any server with an OpenAI-style API. Needs a model that can read images.')}
        {opt('off', 'No AI', 'Scanned pages open in the review window for you to type in.')}
      </div>
      {s.provider === 'claude_code' && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field"><span>Model</span>
            <select value={s.claude_code.model} onChange={(e) => save({ ...s, claude_code: { ...s.claude_code, model: e.target.value } })}>
              <option value="haiku">Haiku (fast, cheapest; fine for data entry)</option>
              <option value="sonnet">Sonnet (more careful)</option>
              <option value="opus">Opus (most careful, slowest)</option>
            </select>
          </label>
          <label className="field"><span>Claude Code command</span>
            <input value={s.claude_code.command} onChange={(e) => setS({ ...s, claude_code: { ...s.claude_code, command: e.target.value } })} onBlur={() => save(s)} style={{ width: 260 }} />
          </label>
        </div>
      )}
      {s.provider === 'anthropic_api' && (
        <label className="field"><span>Model</span>
          <input value={s.anthropic_api.model} onChange={(e) => setS({ ...s, anthropic_api: { model: e.target.value } })} onBlur={() => save(s)} style={{ width: 260 }} />
        </label>
      )}
      {s.provider === 'openai_compatible' && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field"><span>Server address</span>
            <input value={s.openai_compatible.base_url} onChange={(e) => setS({ ...s, openai_compatible: { ...s.openai_compatible, base_url: e.target.value } })} onBlur={() => save(s)} style={{ width: 280 }} />
          </label>
          <label className="field"><span>Model name</span>
            <input value={s.openai_compatible.model} placeholder="e.g. qwen2.5vl:7b" onChange={(e) => setS({ ...s, openai_compatible: { ...s.openai_compatible, model: e.target.value } })} onBlur={() => save(s)} />
          </label>
        </div>
      )}
      {(s.provider === 'anthropic_api' || s.provider === 'openai_compatible') && (
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
          <label className="field">
            <span>API key {s.keys[keyName] ? <b className="ok">(saved)</b> : s.provider === 'openai_compatible' ? '(if your server needs one)' : ''}</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.keys[keyName] ? '•••••••• saved' : 'paste key'} autoComplete="off" style={{ width: 280 }} />
          </label>
          <button className="btn" disabled={!key.trim()} onClick={() => saveKey(key.trim())}>Save key</button>
          {s.keys[keyName] && <button className="btn" onClick={() => saveKey(null)}>Remove key</button>}
        </div>
      )}
      {(s.provider === 'anthropic_api' || s.provider === 'openai_compatible') && (
        <p className="help">The key is stored in a private file on this computer only. It is never shown again, never sent to this page, and not included in exports or backups of your data.</p>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={async () => setTest(await api.post<{ ok: boolean; message: string }>('/settings/ai/test', {}))}>Check it works</button>
        {test && <span className={test.ok ? 'ok' : 'error'}>{test.message}</span>}
      </div>
    </div>
  );
}

function LeadTypesCard() {
  const { toast } = useApp();
  const { types, reload } = useLeadTypes();
  const [edit, setEdit] = useState<Record<string, { label: string; price: string; active: boolean }>>({});
  const [add, setAdd] = useState({ code: '', label: '', price: '' });
  const val = (code: string) => {
    const t = types.find((x) => x.code === code)!;
    return edit[code] ?? { label: t.label, price: t.price_cents == null ? '' : (t.price_cents / 100).toFixed(2), active: !!t.active };
  };
  const cents = (s: string) => (s.trim() === '' ? null : Math.round(Number(s.replace(/[$,]/g, '')) * 100));
  const save = async (code: string, body: { label: string; price: string; active: boolean }) => {
    const c = cents(body.price);
    if (c != null && Number.isNaN(c)) return toast('Price must be a number', 'error');
    try {
      await api.put(`/lead-types/${encodeURIComponent(code)}`, { label: body.label, price_cents: c, active: body.active });
      setEdit((e) => { const n = { ...e }; delete n[code]; return n; });
      await reload();
      toast('Saved. New imports use this price; leads already imported keep theirs.');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="card">
      <h2>Lead types and prices</h2>
      <p className="help">Pre-filled from your IMO's price sheet at level 70. Change them here whenever the prices change.</p>
      <table className="grid" style={{ maxWidth: 760 }}>
        <thead><tr><th>Code</th><th>Name</th><th>Price per lead ($)</th><th>Offered</th><th></th></tr></thead>
        <tbody>
          {types.map((t) => {
            const v = val(t.code);
            const dirty = !!edit[t.code];
            return (
              <tr key={t.code}>
                <td><b>{t.code}</b></td>
                <td><input value={v.label} onChange={(e) => setEdit({ ...edit, [t.code]: { ...v, label: e.target.value } })} style={{ width: '100%' }} /></td>
                <td><input inputMode="decimal" value={v.price} onChange={(e) => setEdit({ ...edit, [t.code]: { ...v, price: e.target.value } })} style={{ width: 90 }} /></td>
                <td><input type="checkbox" checked={v.active} onChange={(e) => setEdit({ ...edit, [t.code]: { ...v, active: e.target.checked } })} aria-label={`${t.code} offered`} /></td>
                <td>{dirty && <button className="btn small primary" onClick={() => save(t.code, v)}>Save</button>}</td>
              </tr>
            );
          })}
          <tr>
            <td><input placeholder="code" value={add.code} onChange={(e) => setAdd({ ...add, code: e.target.value.toUpperCase() })} style={{ width: 70 }} /></td>
            <td><input placeholder="name" value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} style={{ width: '100%' }} /></td>
            <td><input placeholder="price" inputMode="decimal" value={add.price} onChange={(e) => setAdd({ ...add, price: e.target.value })} style={{ width: 90 }} /></td>
            <td></td>
            <td>
              <button className="btn small" disabled={!add.code || !add.label} onClick={async () => { await save(add.code, { label: add.label, price: add.price, active: true }); setAdd({ code: '', label: '', price: '' }); }}>Add type</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function CountiesCard() {
  const { toast } = useApp();
  const [list, setList] = useState<County[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const load = useCallback(() => api.get<County[]>('/counties').then(setList).catch(() => setList([])), []);
  useEffect(() => void load(), [load]);
  const save = async (c: County, text: string) => {
    const codes = [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
    const bad = codes.filter((x) => !/^\d{3}$/.test(x));
    if (bad.length) return toast(`Area codes are 3 digits: ${bad.join(', ')}`, 'error');
    try {
      await api.put('/counties/area-codes', { county_key: c.county_key, area_codes: codes });
      setEdit((e) => { const n = { ...e }; delete n[c.county_key]; return n; });
      await load();
      toast(`Saved area codes for ${c.name}`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="card">
      <h2>Counties and their area codes</h2>
      <p className="help">
        Leads are grouped by the county you bought them for, never by the lead's own phone number. Link each county to the area code(s) you call it under;
        a county can have more than one (Marion County, IN: 317 and 463). On the Calling page you can then pick counties, area codes, or both.
      </p>
      {!list?.length ? (
        <p className="muted">Counties appear here after you import leads.</p>
      ) : (
        <table className="grid" style={{ maxWidth: 860 }}>
          <thead><tr><th>County</th><th>Leads</th><th>Area codes</th><th>Suggestion</th><th></th></tr></thead>
          <tbody>
            {list.map((c) => {
              const text = edit[c.county_key] ?? c.area_codes.join(', ');
              const dirty = edit[c.county_key] !== undefined;
              return (
                <tr key={c.county_key}>
                  <td>{c.name}, {c.state}</td>
                  <td>{c.leads}{c.workable !== c.leads && <span className="muted"> ({c.workable} to call)</span>}</td>
                  <td><input value={text} placeholder="e.g. 574" onChange={(e) => setEdit({ ...edit, [c.county_key]: e.target.value })} style={{ width: 140 }} aria-label={`Area codes for ${c.name}`} /></td>
                  <td>
                    {c.suggested.filter((s) => !c.area_codes.includes(s.area_code)).slice(0, 2).map((s) => (
                      <button key={s.area_code} className="btn small" title={`${s.leads} of this county's leads have ${s.area_code} numbers. A suggestion only.`}
                        onClick={() => setEdit({ ...edit, [c.county_key]: [...new Set([...text.split(/[\s,;]+/).filter(Boolean), s.area_code])].join(', ') })}>
                        + {s.area_code} <span className="muted">({s.leads} leads)</span>
                      </button>
                    ))}
                  </td>
                  <td>{dirty && <button className="btn small primary" onClick={() => save(c, text)}>Save</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
