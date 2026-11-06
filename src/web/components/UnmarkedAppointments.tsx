import { useCallback, useEffect, useState } from 'react';
import { api, type UnmarkedAppts } from '../api';
import { useApp } from '../App';

// A reminder beside the no-shows: appointments on those days still blue in Unitrust can't count as no-shows (or
// anything else) until you mark them there. The extension sends the new color, and "Check again" picks it up.

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function UnmarkedAppointments(props: { days: string; onOpen: (leadId: string) => void; onChecked?: () => void }) {
  const { toast } = useApp();
  const [data, setData] = useState<UnmarkedAppts | null>(null);
  const load = useCallback(
    () => api.get<UnmarkedAppts>('/appointments/unmarked', { days: props.days }).then(setData).catch((e: Error) => toast(`Couldn't check for blue appointments: ${e.message}`, 'error')),
    [props.days, toast],
  );
  useEffect(() => void load(), [load]);
  const n = data?.appointments.length ?? 0;
  if (!data || !n) return null;
  const span = data.from === data.to ? dayLabel(data.from) : `${dayLabel(data.from)} to ${dayLabel(data.to)}`;
  return (
    <div className="needs-look" role="status">
      <span>
        <b>{n} appointment{n === 1 ? '' : 's'} from {span} {n === 1 ? 'is' : 'are'} still blue in Unitrust.</b> Mark {n === 1 ? 'it' : 'them'} there
        (red for a no-show), so {n === 1 ? 'it counts' : 'they count'}:
      </span>
      {data.appointments.map((a) => (
        <button key={a.id} className="btn small" onClick={() => props.onOpen(a.lead_id)} title={`${dayLabel(a.day)}${a.time ? ` ${a.time}` : ''}`}>
          {a.lead_name || 'No name'}
        </button>
      ))}
      <button className="btn small" onClick={() => void load().then(() => props.onChecked?.())}>Check again</button>
    </div>
  );
}
