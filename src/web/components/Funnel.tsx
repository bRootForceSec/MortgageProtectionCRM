import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import { addDays, startOfDay } from '../when';

// Your conversion funnel as an animated 3D graphic sized for an Instagram story (9:16): dials, leads called,
// pickups and appointments set. Opened from the funnel button in the corner of the Calling screen.
// A dial is one ring of a phone; a lead is one person, so several dials can go to the same lead.

interface Stats { dials: number; unique_leads: number; human_contacts: number; appointments: number }

const RANGES = [
  ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All time'],
] as const;
type RangeKey = (typeof RANGES)[number][0];

function rangeOf(k: RangeKey): { from: string; to: string } {
  const today = startOfDay(new Date());
  const to = addDays(today, 1).toISOString();
  switch (k) {
    case 'today': return { from: today.toISOString(), to };
    case 'week': return { from: addDays(today, -today.getDay()).toISOString(), to };
    case 'month': return { from: new Date(today.getFullYear(), today.getMonth(), 1).toISOString(), to };
    case 'all': return { from: new Date(0).toISOString(), to };
  }
}

/** The funnel's four steps, top to bottom, each with its own glow. */
const STEPS = [
  { label: 'Dials', key: 'dials', colors: ['#22d3ee', '#0891b2'] },
  { label: 'Leads called', key: 'unique_leads', colors: ['#818cf8', '#4f46e5'] },
  { label: 'Pickups', key: 'human_contacts', colors: ['#e879f9', '#a21caf'] },
  { label: 'Appts set', key: 'appointments', colors: ['#fbbf24', '#d97706'] },
] as const;

/** The button in the corner of the Calling screen: a small funnel that opens the graphic. */
export function FunnelButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="funnel-fab" onClick={() => setOpen(true)} title="Show my funnel (for sharing)" aria-label="Show my funnel">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <defs>
            <linearGradient id="fab-g" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#22d3ee" /><stop offset=".5" stopColor="#e879f9" /><stop offset="1" stopColor="#fbbf24" />
            </linearGradient>
          </defs>
          <path d="M3 4h18l-6.5 8v6l-5 2.5V12z" fill="url(#fab-g)" />
        </svg>
      </button>
      {open && <FunnelShowcase onClose={() => setOpen(false)} />}
    </>
  );
}

export function FunnelShowcase({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const [range, setRange] = useState<RangeKey>('today');
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    api.get<Stats>('/stats/today', rangeOf(range)).then(setStats).catch((e: Error) => toast(`Couldn't load your numbers: ${e.message}`, 'error'));
  }, [range, toast]);
  const values = stats ? STEPS.map((s) => stats[s.key]) : null;
  const title = RANGES.find(([k]) => k === range)![1];
  return (
    <div
      className="modal-back funnel-back"
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="funnel-wrap" role="dialog" aria-label="My funnel">
        <div className="row funnel-controls">
          {RANGES.map(([k, l]) => (
            <button key={k} className={`btn small${k === range ? ' primary' : ''}`} onClick={() => setRange(k)}>{l}</button>
          ))}
          <button className="btn small" onClick={onClose} aria-label="Close" autoFocus>✕</button>
        </div>
        <FunnelCanvas values={values} title={title} />
        <p className="help funnel-help">Record your screen to post it as a story. Pickups are calls where you reached a person.</p>
      </div>
    </div>
  );
}

const fmt = (n: number) => Math.round(n).toLocaleString();
const pctOf = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '–');

interface Particle { x: number; y: number; v: number; hue: string; dies: number; size: number }

/** The animated funnel: four glowing 3D rings that turn slowly, with sparks falling through them. */
function FunnelCanvas({ values, title }: { values: number[] | null; title: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const data = useRef<{ values: number[] | null; title: string; shownAt: number }>({ values, title, shownAt: performance.now() });
  useEffect(() => {
    data.current = { values, title, shownAt: performance.now() };
  }, [values, title]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const W = 540, H = 960; // drawn at 9:16, scaled by CSS
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = W / 2;
    const top = 250, tierH = 120, gap = 22;
    const radii = [215, 165, 120, 80, 48]; // ring edges, top to bottom
    const tilt = 0.26; // how flat the ellipses are
    const yOf = (i: number) => top + i * (tierH + gap);
    const stars = Array.from({ length: 70 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.4 + 0.3, p: Math.random() * 6 }));
    const parts: Particle[] = [];
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;

    /** The funnel's radius at height y (between tiers it follows the ring above). */
    const radiusAt = (y: number) => {
      for (let i = 0; i < 4; i++) {
        const y0 = yOf(i), y1 = y0 + tierH;
        if (y < y0) return radii[i]!;
        if (y <= y1) return radii[i]! + ((radii[i + 1]! - radii[i]!) * (y - y0)) / tierH;
        if (y < y0 + tierH + gap) return radii[i + 1]!;
      }
      return radii[4]!;
    };
    /** Which tier a height falls in, or -1 above the funnel. */
    const tierAt = (y: number) => (y < top ? -1 : Math.min(3, Math.floor((y - top) / (tierH + gap))));

    const frustum = (i: number, t: number, bob: number) => {
      const y0 = yOf(i) + bob, y1 = y0 + tierH;
      const r0 = radii[i]!, r1 = radii[i + 1]!;
      const [light, dark] = STEPS[i]!.colors;
      // Body: the front half of a cut cone, shaded like a lit tube.
      const g = ctx.createLinearGradient(cx - r0, 0, cx + r0, 0);
      const shine = 0.5 + Math.sin(t * 0.0007 + i) * 0.18;
      g.addColorStop(0, dark + '33');
      g.addColorStop(Math.max(0.05, shine - 0.25), dark + 'cc');
      g.addColorStop(shine, light + 'ee');
      g.addColorStop(Math.min(0.95, shine + 0.25), dark + 'cc');
      g.addColorStop(1, dark + '33');
      // The back of the inside, seen through the open top.
      ctx.beginPath();
      ctx.ellipse(cx, y0, r0, r0 * tilt, 0, Math.PI, 2 * Math.PI);
      ctx.lineTo(cx + r1, y1);
      ctx.ellipse(cx, y1, r1, r1 * tilt, 0, 0, Math.PI, true);
      ctx.closePath();
      ctx.fillStyle = dark + '40';
      ctx.fill();
      // Front.
      ctx.beginPath();
      ctx.moveTo(cx - r0, y0);
      ctx.lineTo(cx - r1, y1);
      ctx.ellipse(cx, y1, r1, r1 * tilt, 0, Math.PI, 0, true);
      ctx.lineTo(cx + r0, y0);
      ctx.ellipse(cx, y0, r0, r0 * tilt, 0, 0, Math.PI);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.shadowColor = light;
      ctx.shadowBlur = 30;
      ctx.fill();
      ctx.shadowBlur = 0;
      // Lines running down the cone, turning slowly so it looks like it spins.
      ctx.save();
      ctx.clip();
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2 + t * 0.00035 * (i % 2 ? -1 : 1);
        const s = Math.sin(a);
        if (s < 0) continue;
        ctx.beginPath();
        ctx.moveTo(cx + r0 * Math.cos(a), y0 + r0 * tilt * s);
        ctx.lineTo(cx + r1 * Math.cos(a), y1 + r1 * tilt * s);
        ctx.strokeStyle = `rgba(255,255,255,${0.08 + s * 0.22})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.restore();
      // Glowing rims.
      for (const [y, r, w] of [[y0, r0, 3], [y1, r1, 2]] as const) {
        ctx.beginPath();
        ctx.ellipse(cx, y, r, r * tilt, 0, 0, Math.PI * 2);
        ctx.strokeStyle = light;
        ctx.lineWidth = w;
        ctx.shadowColor = light;
        ctx.shadowBlur = 18;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    };

    const draw = (t: number) => {
      const { values: v, title: ttl, shownAt } = data.current;
      const grow = Math.min(1, (t - shownAt) / 1400);
      const ease = 1 - Math.pow(1 - grow, 3);

      // Background: deep night with a slow aurora and twinkling stars.
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#070b1f');
      bg.addColorStop(0.55, '#140a2e');
      bg.addColorStop(1, '#05030f');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      const ax = cx + Math.sin(t * 0.0003) * 120;
      const aur = ctx.createRadialGradient(ax, 420, 20, ax, 420, 420);
      aur.addColorStop(0, 'rgba(129,140,248,.28)');
      aur.addColorStop(1, 'rgba(129,140,248,0)');
      ctx.fillStyle = aur;
      ctx.fillRect(0, 0, W, H);
      for (const s of stars) {
        ctx.globalAlpha = 0.35 + 0.45 * Math.abs(Math.sin(t * 0.0012 + s.p));
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Title.
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e0e7ff';
      ctx.font = '600 22px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillText(ttl.toUpperCase(), cx, 92);
      const tg = ctx.createLinearGradient(cx - 180, 0, cx + 180, 0);
      tg.addColorStop(0, '#22d3ee');
      tg.addColorStop(0.5, '#e879f9');
      tg.addColorStop(1, '#fbbf24');
      ctx.fillStyle = tg;
      ctx.font = '800 54px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.shadowColor = '#e879f9';
      ctx.shadowBlur = 24;
      ctx.fillText('MY FUNNEL', cx, 150);
      ctx.shadowBlur = 0;

      const bob = reduce ? 0 : Math.sin(t * 0.0015) * 6;
      for (let i = 0; i < 4; i++) frustum(i, t, bob);

      // Sparks falling through: at each step only the real share carries on, so the flow matches your numbers.
      if (v && !reduce && Math.random() < 0.55) {
        const r0 = radii[0]! * (Math.random() * 1.6 - 0.8);
        let dies = 4;
        for (let i = 1; i < 4; i++) {
          const keep = v[i - 1]! > 0 ? Math.min(1, v[i]! / v[i - 1]!) : 0;
          if (Math.random() > keep) { dies = i; break; }
        }
        parts.push({ x: r0 / radii[0]!, y: top - 30, v: 1.6 + Math.random() * 1.4, hue: STEPS[0]!.colors[0], dies, size: 1.5 + Math.random() * 2 });
      }
      for (let k = parts.length - 1; k >= 0; k--) {
        const p = parts[k]!;
        p.y += p.v;
        const tier = tierAt(p.y - bob);
        const fading = tier >= p.dies;
        const px = cx + p.x * radiusAt(p.y - bob) * 0.85;
        const col = STEPS[Math.max(0, Math.min(3, tier))]!.colors[0];
        const alpha = fading ? Math.max(0, 1 - (p.y - bob - yOf(p.dies)) / 60) : 1;
        if (alpha <= 0 || p.y > H) { parts.splice(k, 1); continue; }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(px, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      // Labels: the number counts up on the ring, the name under it, and the share that made it to the next step.
      for (let i = 0; i < 4; i++) {
        const yMid = yOf(i) + bob + tierH * 0.55;
        const n = v ? v[i]! * ease : 0;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,.6)';
        ctx.shadowBlur = 8;
        ctx.font = `800 ${i === 3 ? 50 : 44}px system-ui, -apple-system, Segoe UI, sans-serif`;
        ctx.fillText(v ? fmt(n) : '…', cx, yMid);
        ctx.font = '600 17px system-ui, -apple-system, Segoe UI, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.fillText(STEPS[i]!.label.toUpperCase(), cx, yMid + 26);
        ctx.shadowBlur = 0;
        if (i > 0 && v) {
          const y = yOf(i) + bob - gap / 2 + 6;
          ctx.textAlign = 'left';
          ctx.font = '700 18px system-ui, -apple-system, Segoe UI, sans-serif';
          ctx.fillStyle = STEPS[i]!.colors[0];
          ctx.fillText(`↓ ${pctOf(v[i]!, v[i - 1]!)}`, cx + radii[i]! + 18, y);
        }
      }

      // The bottom line: appointments out of dials.
      if (v) {
        ctx.textAlign = 'center';
        ctx.font = '600 20px system-ui, -apple-system, Segoe UI, sans-serif';
        ctx.fillStyle = '#fde68a';
        ctx.fillText(`${pctOf(v[3]!, v[0]!)} of dials became appointments`, cx, H - 70);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="funnel-canvas" aria-label="Funnel: dials, leads called, pickups and appointments set" role="img" />;
}
