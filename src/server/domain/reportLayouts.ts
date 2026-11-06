import type { DB } from '../db/connection.js';
import { getSetting, setSetting } from '../core/settings.js';
import { ReportLayouts } from '../../shared/reportLayout.js';

// How you arranged Reports and the presets you saved (the shapes are in src/shared/reportLayout.ts).

export function loadReportLayouts(db: DB): ReportLayouts {
  const r = ReportLayouts.safeParse(getSetting<unknown>(db, 'report_layouts') ?? {});
  // A bad stored value never blocks Reports: fall back to the default arrangement.
  return r.success ? r.data : ReportLayouts.parse({});
}

export function saveReportLayouts(db: DB, input: unknown): ReportLayouts {
  const s = ReportLayouts.parse(input);
  setSetting(db, 'report_layouts', s);
  return s;
}
