import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, type LeadDetail } from '../api';

// The page the lead came from, beside the call: the PDF page when the lead was imported from a PDF,
// else the row as it was in the spreadsheet. Fitted to the panel's width so it can be read as is;
// scroll the wheel to zoom where the pointer is, drag to move it, Reset puts it back.

const MIN = 0.5;
const MAX = 6;
const STEP = 1.25;

interface View { scale: number; x: number; y: number; rotate: number }
const START: View = { scale: 1, x: 0, y: 0, rotate: 0 };

export function SourcePage({ d }: { d: LeadDetail }) {
  const page = d.lead.source_page as number | null;
  const raw = rawRow(d);
  const pdf = d.source_pdf && page != null;
  return (
    <section className="panel lead-page" aria-label="Lead page">
      {pdf ? (
        <PdfPage key={d.lead.id} leadId={d.lead.id} file={`/api/batches/${d.batch.id}/file`} page={page} />
      ) : raw.length ? (
        <ZoomPan key={d.lead.id} title={d.batch.file_name ? `Row ${d.import_row?.row_number ?? ''} of ${d.batch.file_name}` : 'As imported'}>
          <table className="grid source-row">
            <tbody>
              {raw.map(([k, v]) => (
                <tr key={k}><th>{k}</th><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </ZoomPan>
      ) : (
        <div className="empty">No lead page was kept for this lead.</div>
      )}
    </section>
  );
}

/** The imported row's values, without the app's own bookkeeping keys and blanks. */
function rawRow(d: LeadDetail): [string, string][] {
  try {
    const r = JSON.parse(d.import_row?.raw_json ?? 'null') as Record<string, unknown> | null;
    if (!r) return [];
    return Object.entries(r)
      .filter(([k, v]) => !k.startsWith('__') && v !== null && v !== undefined && String(v).trim() !== '')
      .map(([k, v]) => [k, String(v)]);
  } catch {
    return [];
  }
}

function PdfPage({ leadId, file, page }: { leadId: string; file: string; page: number }) {
  const shown = useRef<HTMLCanvasElement>(null);
  // Drawn off screen first, then copied over, so the page doesn't blink when it sharpens after a zoom.
  const work = useRef<HTMLCanvasElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [rotate, setRotate] = useState(0);
  const [quality, setQuality] = useState(1);
  // Bumped after a turn is saved, so the changed PDF is fetched again.
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const url = version ? `${file}?v=${version}` : file;

  const keepTurn = async () => {
    setSaving(true);
    try {
      await api.post(`/leads/${leadId}/page-turn`, { turn: rotate });
      setRotate(0);
      setVersion(Date.now());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!width || !shown.current) return;
    const el = shown.current;
    const off = (work.current ??= document.createElement('canvas'));
    let stale = false;
    setErr(null);
    import('../pdfView')
      .then((m) => m.renderPage(off, url, page, width, rotate, quality))
      .then(() => {
        if (stale || !off.width) return;
        el.width = off.width;
        el.height = off.height;
        el.getContext('2d')?.drawImage(off, 0, 0);
        // Drawn sharper than needed when zoomed; shown at the panel's width, and the zoom scales it up.
        el.style.width = `${width}px`;
        el.style.height = `${Math.round((off.height / off.width) * width)}px`;
      })
      .catch((e) => !stale && setErr(String(e?.message ?? e)));
    return () => { stale = true; };
  }, [url, page, width, rotate, quality]);

  return (
    <ZoomPan
      title={`PDF page ${page}`}
      onWidth={setWidth}
      onScale={(s) => setQuality(s > 1.05 ? Math.min(3, Math.ceil(s)) : 1)}
      onRotate={() => setRotate((r) => (r + 90) % 360)}
      onReset={() => setRotate(0)}
      extra={
        <>
          {rotate !== 0 && (
            <button type="button" className="btn small primary" onClick={() => void keepTurn()} disabled={saving} title="Save this page turned this way, so it shows the right way up from now on">
              {saving ? 'Saving…' : 'Keep this way'}
            </button>
          )}
          <a className="btn small" href={`${url}#page=${page}`} target="_blank" rel="noreferrer" title="Open the whole PDF in a new tab">Open PDF</a>
        </>
      }
    >
      {err ? <p className="error">Couldn't show this page ({err}). Use "Open PDF".</p> : <canvas ref={shown} aria-label={`Lead page ${page}`} />}
    </ZoomPan>
  );
}

/**
 * A view you can zoom (wheel, double-click, buttons) and drag around. The content is laid out at the
 * view's width, so scale 1 is "fit to width".
 */
function ZoomPan({
  title, children, extra, onWidth, onScale, onRotate, onReset,
}: {
  title: string;
  children: ReactNode;
  extra?: ReactNode;
  onWidth?: (w: number) => void;
  onScale?: (s: number) => void;
  onRotate?: () => void;
  onReset?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(START);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [width, setWidth] = useState(0);
  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number } | null>(null);

  // Keeps at least part of the page in view, so it can't be lost off the edge.
  const clamp = useCallback((v: View): View => {
    const b = box.current;
    const c = content.current;
    if (!b || !c) return v;
    const keep = 60;
    const w = c.offsetWidth * v.scale;
    const h = c.offsetHeight * v.scale;
    return {
      ...v,
      x: Math.min(b.clientWidth - keep, Math.max(keep - w, v.x)),
      y: Math.min(b.clientHeight - keep, Math.max(keep - h, v.y)),
    };
  }, []);

  /** Zooms by `factor`, keeping the point (px, py) of the view where it is. */
  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const b = box.current;
    if (!b) return;
    const v = viewRef.current;
    const scale = Math.min(MAX, Math.max(MIN, v.scale * factor));
    const cx = px ?? b.clientWidth / 2;
    const cy = py ?? b.clientHeight / 2;
    const k = scale / v.scale;
    setView(clamp({ ...v, scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }));
  }, [clamp]);

  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(b.clientWidth))));
    ro.observe(b);
    return () => ro.disconnect();
  }, []);

  // Re-render the content for a new width a moment after resizing stops.
  useEffect(() => {
    if (!width || !onWidth) return;
    const t = setTimeout(() => onWidth(width), 120);
    return () => clearTimeout(t);
  }, [width]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sharpen once zooming settles.
  useEffect(() => {
    if (!onScale) return;
    const t = setTimeout(() => onScale(view.scale), 200);
    return () => clearTimeout(t);
  }, [view.scale]); // eslint-disable-line react-hooks/exhaustive-deps

  // The wheel listener can't be passive: it stops the panel scrolling while you zoom.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = b.getBoundingClientRect();
      const factor = Math.exp(-Math.max(-100, Math.min(100, e.deltaMode ? e.deltaY * 16 : e.deltaY)) * 0.0025);
      zoomAt(factor, e.clientX - r.left, e.clientY - r.top);
    };
    b.addEventListener('wheel', onWheel, { passive: false });
    return () => b.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const reset = () => {
    setView(START);
    onReset?.();
  };

  return (
    <>
      <header className="page-tools">
        <span className="muted page-title" title={title}>{title}</span>
        <button type="button" className="btn small" onClick={() => zoomAt(1 / STEP)} disabled={view.scale <= MIN} aria-label="Zoom out">−</button>
        <span className="zoom-pct" aria-live="polite">{Math.round(view.scale * 100)}%</span>
        <button type="button" className="btn small" onClick={() => zoomAt(STEP)} disabled={view.scale >= MAX} aria-label="Zoom in">+</button>
        {onRotate && <button type="button" className="btn small" onClick={onRotate} title="Turn the page a quarter turn">⟳ Turn</button>}
        <button type="button" className="btn small" onClick={reset} title="Back to the page as it first showed: fitted to the panel, not turned">Reset</button>
        {extra}
      </header>
      <div
        ref={box}
        className="zoom-pan"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (!g || g.id !== e.pointerId) return;
          setView((v) => clamp({ ...v, x: g.vx + e.clientX - g.x, y: g.vy + e.clientY - g.y }));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          zoomAt(2, e.clientX - r.left, e.clientY - r.top);
        }}
      >
        <div
          ref={content}
          className="zoom-content"
          style={{ width: width || undefined, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {children}
        </div>
      </div>
    </>
  );
}
