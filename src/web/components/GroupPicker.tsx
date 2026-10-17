import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';

// Pick which leads to see or work: by the county they were bought for, by area code (every county linked
// to that code, never the lead's own number), or both. The same choice applies on every page.

const GROUPS_KEY = 'mpcrm.queue.groups';

export interface Groups {
  counties: string[];
  areaCodes: string[];
}
export interface CountyOption {
  county_key: string;
  name: string;
  state: string;
  workable: number;
  area_codes: string[];
}

function loadGroups(): Groups {
  try {
    const g = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? 'null');
    if (g && Array.isArray(g.counties) && Array.isArray(g.areaCodes)) return g;
  } catch {
    /* ignore */
  }
  return { counties: [], areaCodes: [] };
}

/** The shared county / area-code choice, kept in this browser and the same on every page. */
export function useGroups(): [Groups, (g: Groups) => void, Record<string, string>] {
  const [groups, setState] = useState<Groups>(loadGroups);
  useEffect(() => {
    const f = () => setState(loadGroups());
    window.addEventListener('mpcrm:groups', f);
    return () => window.removeEventListener('mpcrm:groups', f);
  }, []);
  const set = useCallback((g: Groups) => {
    setState(g);
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(g));
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new Event('mpcrm:groups'));
  }, []);
  return [groups, set, { counties: groups.counties.join(','), area_codes: groups.areaCodes.join(',') }];
}

export function GroupPicker({ groups, onChange }: { groups: Groups; onChange: (g: Groups) => void }) {
  const { go } = useApp();
  const [counties, setCounties] = useState<CountyOption[]>([]);
  useEffect(() => {
    api.get<CountyOption[]>('/counties').then(setCounties).catch(() => {});
  }, []);
  if (!counties.length) return null;
  const codes = [...new Set(counties.flatMap((c) => c.area_codes))].sort();
  const name = (k: string) => {
    const c = counties.find((x) => x.county_key === k);
    return c ? `${c.name}, ${c.state}` : k.split('|').reverse().join(', ');
  };
  const add = (v: string) => {
    if (v === 'settings') return go('settings');
    if (v.startsWith('ac:')) onChange({ ...groups, areaCodes: [...new Set([...groups.areaCodes, v.slice(3)])] });
    else if (v.startsWith('co:')) onChange({ ...groups, counties: [...new Set([...groups.counties, v.slice(3)])] });
  };
  const empty = !groups.counties.length && !groups.areaCodes.length;
  const unlinked = counties.filter((c) => !c.area_codes.length);
  return (
    <div className="group-picker">
      <select value="" onChange={(e) => add(e.target.value)} aria-label="Choose counties or area codes">
        <option value="">{empty ? 'All counties' : 'Add a county or area code…'}</option>
        <optgroup label="Area codes (every county under the code)">
          {codes.filter((c) => !groups.areaCodes.includes(c)).map((c) => (
            <option key={c} value={`ac:${c}`}>{c}: {counties.filter((x) => x.area_codes.includes(c)).map((x) => x.name).join(', ')}</option>
          ))}
          {!codes.length && <option disabled>No area codes linked yet</option>}
        </optgroup>
        <optgroup label="Counties">
          {counties.filter((c) => !groups.counties.includes(c.county_key)).map((c) => (
            <option key={c.county_key} value={`co:${c.county_key}`}>
              {c.name}, {c.state}{c.area_codes.length ? ` (${c.area_codes.join(', ')})` : ''} · {c.workable} to call
            </option>
          ))}
        </optgroup>
        {unlinked.length > 0 && (
          <optgroup label={`${unlinked.length} ${unlinked.length === 1 ? 'county has' : 'counties have'} no area code`}>
            <option value="settings">Link area codes in Settings…</option>
          </optgroup>
        )}
      </select>
      {groups.areaCodes.map((c) => (
        <span key={c} className="chip">{c}<button onClick={() => onChange({ ...groups, areaCodes: groups.areaCodes.filter((x) => x !== c) })} aria-label={`Remove ${c}`}>×</button></span>
      ))}
      {groups.counties.map((k) => (
        <span key={k} className="chip">{name(k)}<button onClick={() => onChange({ ...groups, counties: groups.counties.filter((x) => x !== k) })} aria-label={`Remove ${name(k)}`}>×</button></span>
      ))}
      {!empty && <button className="btn small" onClick={() => onChange({ counties: [], areaCodes: [] })}>All counties</button>}
    </div>
  );
}
