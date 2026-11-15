import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import { useApp } from '../App';

// Texting a lead from your phone: pick one of your texts (1-9), and it shows as a QR code of just the words. Your
// phone's camera (or Google Lens) offers to copy it; paste it into the app you text from. It's copied here too, so
// with clipboard sync (KDE Connect) it's already on your phone. Enter marks it sent on the lead.

interface FilledText { id: string; name: string; text: string; missing: string[] }
interface LeadTexts { blocked: string | null; texts: FilledText[] }

export function TextPicker({ leadId, who, onClose }: { leadId: string; who: string; onClose: () => void }) {
  const { toast, calling } = useApp();
  const [data, setData] = useState<LeadTexts | null>(null);
  const [pick, setPick] = useState<FilledText | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const toPhone = !!calling?.settings.kdeconnect_device;

  useEffect(() => {
    api.get<LeadTexts>(`/leads/${leadId}/texts`).then(setData).catch((e: Error) => {
      toast(`Couldn't load your texts: ${e.message}`, 'error');
      onClose();
    });
  }, [leadId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [tooBig, setTooBig] = useState(false);
  useEffect(() => {
    box.current?.focus();
    setTooBig(false);
    // A very long text (most often one with emoji or curly quotes, which take more room) can be past what a QR code holds.
    if (pick && canvas.current) QRCode.toCanvas(canvas.current, pick.text, { width: pick.text.length > 400 ? 480 : 320, margin: 2, errorCorrectionLevel: 'L' }).catch(() => setTooBig(true));
  }, [pick, data]);

  const copy = useCallback(async (t: FilledText, quiet = false) => {
    try {
      await navigator.clipboard.writeText(t.text);
      if (!quiet) toast(`Copied "${t.name}"`);
    } catch {
      if (!quiet) toast('Could not copy; scan the code instead', 'error');
    }
  }, [toast]);

  const choose = useCallback((t: FilledText) => {
    setPick(t);
    // Copied straight away, so clipboard sync puts it on your phone with no scan.
    void copy(t, true);
  }, [copy]);

  const sendToPhone = async (t: FilledText) => {
    try {
      await api.post('/texts/to-phone', { text: t.text });
      toast('Sent to your phone\'s clipboard');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const sent = async (t: FilledText) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/leads/${leadId}/texted`, { text_id: t.id });
      toast(`Noted: texted ${who} "${t.name}"`);
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); return pick ? setPick(null) : onClose(); }
    if (!data || data.blocked) return;
    if (!pick) {
      const n = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
      const t = n ? data.texts[n - 1] : undefined;
      if (t) { e.preventDefault(); choose(t); }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); void sent(pick); }
    else if (e.key === 'Backspace') { e.preventDefault(); setPick(null); }
    else if (e.key.toLowerCase() === 'c') { e.preventDefault(); void copy(pick); }
    else if (e.key.toLowerCase() === 'p' && toPhone) { e.preventDefault(); void sendToPhone(pick); }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal qr text-picker" role="dialog" aria-label={`Text ${who}`} tabIndex={-1} ref={box} onKeyDown={onKey} onClick={(e) => e.stopPropagation()}>
        <header><b>{pick ? pick.name : `Text ${who}`}</b><button className="icon-btn" aria-label="Close" onClick={onClose}>×</button></header>
        <div className="body">
          {!data ? (
            <p className="muted">Loading…</p>
          ) : data.blocked ? (
            <>
              <p className="never-dial" role="alert">Don't text this lead: {data.blocked}.</p>
              <button className="btn" onClick={onClose}>Close <kbd>Esc</kbd></button>
            </>
          ) : !pick ? (
            data.texts.length === 0 ? (
              <p className="help">You have no texts yet. Add them under Settings → Calling, Texts.</p>
            ) : (
              <ol className="text-choices" aria-label="Your texts">
                {data.texts.map((t, i) => (
                  <li key={t.id}>
                    <button className="btn" onClick={() => choose(t)}>
                      {i < 9 && <kbd>{i + 1}</kbd>} <b>{t.name}</b>
                      <span className="muted small">{t.text}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )
          ) : (
            <div style={{ textAlign: 'center' }}>
              <canvas ref={canvas} aria-label={`QR code of the text "${pick.name}"`} hidden={tooBig} />
              {tooBig && <p className="warn">This text is too long for a QR code. Use Copy or Send to phone, or shorten it in Settings.</p>}
              <p className="text-preview">{pick.text}</p>
              {pick.missing.length > 0 && (
                <p className="warn">Left blank, this lead has no {pick.missing.join(', ')}. Read it over before you send.</p>
              )}
              <p className="help">Point your phone's camera at the code, tap Copy, and paste it into your texting app. It's on this computer's clipboard too.</p>
              <div className="row" style={{ justifyContent: 'center', gap: 6 }}>
                <button className="btn primary" disabled={busy} onClick={() => void sent(pick)}>Sent <kbd>Enter</kbd></button>
                <button className="btn" onClick={() => void copy(pick)}>Copy <kbd>C</kbd></button>
                {toPhone && <button className="btn" onClick={() => void sendToPhone(pick)} title="Puts the text on your phone's clipboard with KDE Connect">Send to phone <kbd>P</kbd></button>}
                <button className="btn" onClick={() => setPick(null)}>Back <kbd>Backspace</kbd></button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
