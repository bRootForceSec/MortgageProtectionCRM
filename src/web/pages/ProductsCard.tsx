import { useCallback, useEffect, useState } from 'react';
import { api, type CompLevel, type Product } from '../api';
import { useApp } from '../App';
import { ymd } from '../when';
import { PRODUCT_KINDS } from '../../shared/policies';

// Settings → Products and comp: your Unitrust comp level over time, and the rules for each carrier + product the
// extension has found on the Business Management Report. Commission = AP × (level − comp hit) % × advance %.

type Edit = { kind: string; hit: string; advance: string };

const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

export function ProductsCard() {
  const { toast, reloadMeta } = useApp();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [levels, setLevels] = useState<CompLevel[]>([]);
  const [edit, setEdit] = useState<Record<string, Edit>>({});
  const [add, setAdd] = useState({ level: '', from: ymd(new Date()) });
  const load = useCallback(
    () => api.get<{ products: Product[]; levels: CompLevel[] }>('/products').then((r) => { setProducts(r.products); setLevels(r.levels); }).catch((e) => toast(e.message, 'error')),
    [toast],
  );
  useEffect(() => void load(), [load]);
  if (!products) return null;

  const current = levels.at(-1)?.level ?? null;
  const val = (p: Product): Edit => edit[p.id] ?? {
    kind: p.kind ?? '', hit: p.comp_hit_points == null ? '' : String(p.comp_hit_points), advance: p.advance_pct == null ? '' : String(p.advance_pct),
  };
  const save = async (p: Product, v: Edit) => {
    const hit = numOrNull(v.hit);
    const advance = numOrNull(v.advance);
    if ((hit != null && Number.isNaN(hit)) || (advance != null && Number.isNaN(advance))) return toast('Comp hit and advance must be numbers', 'error');
    try {
      await api.put(`/products/${p.id}`, { kind: v.kind || null, comp_hit_points: hit, advance_pct: advance });
      setEdit((e) => { const n = { ...e }; delete n[p.id]; return n; });
      await load();
      reloadMeta();
      toast('Saved. Reports use these rules now, for old policies too.');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const addLevel = async () => {
    const level = Number(add.level);
    if (!add.level || Number.isNaN(level)) return toast('Type your comp level, like 70', 'error');
    try {
      const r = await api.post<{ levels: CompLevel[] }>('/comp-levels', { level, effective_from: add.from });
      setLevels(r.levels);
      setAdd({ ...add, level: '' });
      toast('Comp level saved');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const removeLevel = async (l: CompLevel) => {
    if (!window.confirm(`Remove level ${l.level} from ${l.effective_from}?`)) return;
    try {
      setLevels((await api.del<{ levels: CompLevel[] }>(`/comp-levels/${l.id}`)).levels);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const missing = products.filter((p) => p.needs_rules).length;

  return (
    <div className="card" id="products">
      <h2>Products and comp</h2>
      <p className="help">
        What each policy pays you: AP × (your comp level − the product's comp hit) × the advance %. The extension adds each
        carrier and product it sees on Unitrust's Business Management Report. Fill in the comp hit (0 for level comp) and
        the advance % so its policies count. Chargebacks and the AP paid after the advance aren't counted.
      </p>

      <h3>Your Unitrust comp level</h3>
      <div className="row">
        <span>Now: <b>{current ?? 'not set'}</b></span>
        <label className="field"><span>Level</span><input inputMode="decimal" value={add.level} onChange={(e) => setAdd({ ...add, level: e.target.value })} style={{ width: 70 }} aria-label="Comp level" /></label>
        <label className="field"><span>From</span><input type="date" value={add.from} onChange={(e) => setAdd({ ...add, from: e.target.value })} aria-label="Comp level from" /></label>
        <button className="btn small" onClick={addLevel}>Save level</button>
      </div>
      {levels.length > 0 && (
        <p className="help">
          {levels.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ' · '}{l.level} from {l.effective_from} <span className="muted">({l.source === 'unitrust' ? 'read from Unitrust' : 'set here'})</span>
              {' '}<button className="icon-btn" style={{ visibility: 'visible' }} onClick={() => void removeLevel(l)} aria-label={`Remove level ${l.level} from ${l.effective_from}`}>×</button>
            </span>
          ))}
          . Each policy uses the level from its application day.
        </p>
      )}

      <h3>Products {missing > 0 && <span className="warn small">({missing} need{missing === 1 ? 's' : ''} comp rules)</span>}</h3>
      {products.length === 0 ? (
        <p className="muted">None yet. Open the Business Management Report in Unitrust with the extension installed.</p>
      ) : (
        <div className="scroll-x">
          <table className="grid">
            <thead>
              <tr><th>Carrier</th><th>Product</th><th>Type</th><th title="Points off your comp level. 0 for level comp.">Comp hit (points)</th><th>Advance %</th><th>You get</th><th>Policies</th><th></th></tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const v = val(p);
                const hit = numOrNull(v.hit);
                const advance = numOrNull(v.advance);
                const comp = current != null && hit != null && !Number.isNaN(hit) ? Math.max(0, current - hit) : null;
                const set = (patch: Partial<Edit>) => setEdit({ ...edit, [p.id]: { ...v, ...patch } });
                return (
                  <tr key={p.id} className={p.needs_rules ? 'needs-rules' : undefined}>
                    <td>{p.carrier}</td>
                    <td>{p.name}{p.needs_rules && <div className="warn small">needs comp rules</div>}</td>
                    <td>
                      <select value={v.kind} onChange={(e) => set({ kind: e.target.value })} aria-label={`${p.name} type`}>
                        <option value="">–</option>
                        {PRODUCT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                      </select>
                    </td>
                    <td><input inputMode="decimal" value={v.hit} onChange={(e) => set({ hit: e.target.value })} style={{ width: 70 }} aria-label={`${p.name} comp hit`} /></td>
                    <td><input inputMode="decimal" value={v.advance} onChange={(e) => set({ advance: e.target.value })} style={{ width: 70 }} aria-label={`${p.name} advance %`} /></td>
                    <td className="muted">{comp != null && advance != null && !Number.isNaN(advance) ? `${comp}% × ${advance}%` : '–'}</td>
                    <td>{p.policies}</td>
                    <td>{edit[p.id] && <button className="btn small primary" onClick={() => void save(p, v)}>Save</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
