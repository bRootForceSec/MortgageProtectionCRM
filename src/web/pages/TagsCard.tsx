import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { useTags } from '../tags';
import { ExpiryPicker, TagGroups, useTagShortcuts } from './TagShortcuts';

// Automation → Tags.

/** Your tags: rename or delete them, and their shortcuts. You add them on a lead, or to many at once from Leads. */
export function TagsCard() {
  const { toast } = useApp();
  const { tags, reload: reloadTags } = useTags();
  const sc = useTagShortcuts();
  // A rename or delete changes the rules the shortcuts write.
  const reload = async () => { await Promise.all([reloadTags(), sc.load()]); };
  const [edit, setEdit] = useState<Record<string, string>>({});
  const rename = async (id: string) => {
    try {
      await api.put(`/tags/${id}`, { name: edit[id] });
      setEdit((e) => { const n = { ...e }; delete n[id]; return n; });
      await reload();
      toast('Tag renamed');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const neverDial = async (id: string, name: string, on: boolean) => {
    try {
      await api.put(`/tags/${id}/never-dial`, { on });
      await reloadTags();
      toast(on ? `Leads tagged ${name} are never dialed` : `${name} no longer stops dialing`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const remove = async (id: string, name: string, leads: number) => {
    if (!window.confirm(`Delete the tag "${name}"?${leads ? ` It comes off ${leads} lead${leads === 1 ? '' : 's'}.` : ''} Routine steps that filter by it will match no one.`)) return;
    try {
      await api.del(`/tags/${id}`);
      await reload();
      toast(`Deleted "${name}"`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="card" id="tags">
      <h2>Tags</h2>
      <p className="help">
        Your own labels on leads. Add one on a lead (the + Tag button under its name), or to every lead matching your filters with Leads → Tag all matching.
        Filter by tag on Leads and in routine steps. A tag can come off by itself, at the end of the day or after some hours: that writes a rule, shown in
        Automation → Rules. Mark a tag <b>Never dial</b> (like DNC) and a lead with it is left off the call list, whatever adds it (you can still add it
        anyway), and the Calling screen shows a red banner and asks before dialing it.
      </p>
      {tags.length === 0 ? <p className="muted">No tags yet.</p> : (
        <table className="grid" style={{ maxWidth: 760 }}>
          <thead><tr><th>Name</th><th>Leads</th><th>Comes off</th><th title="A lead with this tag is left off the call list, and the Calling screen asks before dialing it">Never dial</th><th></th></tr></thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.id}>
                <td><input value={edit[t.id] ?? t.name} maxLength={40} aria-label={`Name of tag ${t.name}`} onChange={(e) => setEdit({ ...edit, [t.id]: e.target.value })} style={{ width: '100%' }} /></td>
                <td>{t.leads}</td>
                <td><ExpiryPicker tag={t} sc={sc} /></td>
                <td><input type="checkbox" checked={t.never_dial} aria-label={`${t.name}: never dial`} onChange={(e) => void neverDial(t.id, t.name, e.target.checked)} /></td>
                <td className="nowrap">
                  {edit[t.id] != null && edit[t.id] !== t.name && <button className="btn small primary" onClick={() => void rename(t.id)}>Save</button>}{' '}
                  <button className="btn small" onClick={() => void remove(t.id, t.name, t.leads)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <TagGroups tags={tags} sc={sc} />
    </div>
  );
}
