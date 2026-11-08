import { useState } from 'react';

const TABLES = [
  ['leads', 'Leads'], ['calls', 'Calls'], ['outcomes', 'Outcomes (every change)'], ['events', 'Raw call events'], ['notes', 'Notes'],
  ['batches', 'Import batches'], ['import_rows', 'Imported rows (incl. rejected)'], ['numbers', 'Caller ID numbers'],
] as const;

// Export: every table as CSV or Excel, and the full dump. Backups are in Settings (BackupsCard).

export function DataPage() {
  const [health, setHealth] = useState(false);
  const h = health ? '?health=1' : '';

  return (
    <>
      <div className="card">
        <h2>Export</h2>
        <label className="row">
          <input type="checkbox" checked={health} onChange={(e) => setHealth(e.target.checked)} />
          Include health and tobacco fields (leave off unless you need them; exported files are not encrypted)
        </label>
        <div className="row" style={{ marginTop: 10 }}>
          <a className="btn primary" href={`/api/export/all.xlsx${h}`}>Everything (Excel, one sheet per table)</a>
          <a className="btn" href="/api/export/dump.json" title="Every table, every column, including health fields">Full JSON dump</a>
        </div>
        <table className="grid" style={{ marginTop: 10 }}>
          <tbody>
            {TABLES.map(([k, label]) => (
              <tr key={k}><td>{label}</td><td><a href={`/api/export/${k}.csv${h}`}>CSV</a></td><td><a href={`/api/export/${k}.xlsx${h}`}>Excel</a></td></tr>
            ))}
          </tbody>
        </table>
        <p className="help">The full JSON dump always includes every field. Treat it like the database itself.</p>
      </div>

    </>
  );
}
