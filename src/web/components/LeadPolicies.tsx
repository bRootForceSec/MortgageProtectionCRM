import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, type PolicyView } from '../api';
import { useApp } from '../App';

// A lead's policies from the Unitrust Business Management Report, with what each one pays, and linking a policy the
// extension couldn't match (a different phone or name) to this lead by hand.

const STAGE: Record<PolicyView['stage'], string> = { paid: 'paid', pending: 'pending', out: 'not counted' };

export function policyPay(p: PolicyView) {
  if (p.stage === 'out') return 'not counted';
  if (p.commission_cents == null) return p.level == null ? 'comp level not set' : 'comp rules not set';
  return `${fmtMoney(p.commission_cents)}${p.stage === 'pending' ? ' when paid' : ''}`;
}

export function LeadPolicies({ leadId }: { leadId: string }) {
  const { toast } = useApp();
  const [mine, setMine] = useState<PolicyView[] | null>(null);
  const [free, setFree] = useState<PolicyView[] | null>(null);
  const load = useCallback(
    () => api.get<{ policies: PolicyView[] }>('/policies', { lead: leadId }).then((r) => setMine(r.policies)).catch((e) => toast(e.message, 'error')),
    [leadId, toast],
  );
  useEffect(() => void load(), [load]);
  const link = async (id: string, lead: string | null) => {
    try {
      await api.put(`/policies/${id}/lead`, { lead_id: lead });
      setFree(null);
      await load();
      toast(lead ? 'Policy linked to this lead' : 'Policy unlinked');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const pick = async () => {
    try {
      setFree((await api.get<{ policies: PolicyView[] }>('/policies', { unlinked: '1' })).policies);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  if (!mine) return null;
  return (
    <section aria-label="Policies" style={{ marginTop: 10 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>Policies</h3>
        {free == null && <button className="btn small" onClick={() => void pick()} title="Link a policy from Unitrust that didn't match any lead">Link a policy</button>}
      </div>
      {free != null && (
        <div className="row">
          {free.length === 0 ? <span className="muted">Every policy is already linked to a lead.</span> : (
            <select defaultValue="" onChange={(e) => e.target.value && void link(e.target.value, leadId)} aria-label="Policy to link">
              <option value="">Pick a policy with no lead…</option>
              {free.map((p) => <option key={p.id} value={p.id}>{p.client_name ?? p.unitrust_app_id} · {p.carrier} {p.product} · {p.status}</option>)}
            </select>
          )}
          <button className="btn small" onClick={() => setFree(null)}>Cancel</button>
        </div>
      )}
      {mine.length === 0 ? <p className="muted small">None from Unitrust yet.</p> : (
        <table className="grid">
          <thead><tr><th>Product</th><th>Status</th><th>Applied</th><th>AP</th><th>Pays you</th><th></th></tr></thead>
          <tbody>
            {mine.map((p) => (
              <tr key={p.id}>
                <td>{p.carrier} {p.product}<div className="muted small">{p.unitrust_app_id}{p.policy_number ? ` · ${p.policy_number}` : ''}</div></td>
                <td>{p.status}<div className="muted small">{STAGE[p.stage]}</div></td>
                <td>{p.applied_on ?? ''}</td>
                <td>{fmtMoney(p.ap_cents)}</td>
                <td title={p.level != null && p.comp_hit_points != null && p.advance_pct != null ? `${p.level} − ${p.comp_hit_points} = ${p.level - p.comp_hit_points}% × ${p.advance_pct}% advance` : undefined}>
                  {policyPay(p)}
                </td>
                <td><button className="btn small" onClick={() => void link(p.id, null)} title="This policy isn't this lead's">Unlink</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
