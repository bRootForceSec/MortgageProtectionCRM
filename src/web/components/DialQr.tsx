import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { fmtPhone } from '../api';

// A QR code of the number. Point your phone's camera at it (Android or iPhone) and tap to call.

export function DialQr({ e164, onClose }: { e164: string; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (canvas.current) void QRCode.toCanvas(canvas.current, `tel:${e164}`, { width: 280, margin: 2 });
    closeBtn.current?.focus();
  }, [e164]);
  return (
    <div className="modal-back" onClick={onClose} onKeyDown={(e) => (e.key === 'Escape' || e.key === 'Enter') && (e.stopPropagation(), onClose())}>
      <div className="modal qr" role="dialog" aria-label="Scan to dial" onClick={(e) => e.stopPropagation()}>
        <header><b>Scan to dial {fmtPhone(e164)}</b></header>
        <div className="body" style={{ textAlign: 'center' }}>
          <canvas ref={canvas} aria-label={`QR code for ${fmtPhone(e164)}`} />
          <p className="help">Open your phone's camera and point it here, then tap the number to call. The timer has started.</p>
          <button ref={closeBtn} className="btn" onClick={onClose}>Close <kbd>Esc</kbd></button>
        </div>
      </div>
    </div>
  );
}
