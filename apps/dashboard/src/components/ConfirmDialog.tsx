/** Modal confirmation (role="dialog"): Escape or "Huỷ" cancels; focus starts on the confirm button. */
import { useEffect, useId, type ReactNode } from 'react';

export function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
  return (
    <div className="backdrop">
      <div className="card dialog" role="dialog" aria-modal="true" aria-labelledby={id}>
        <h2 id={id}>{title}</h2>
        {children}
        <div className="btn-row">
          <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
            Huỷ
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={onConfirm}
            autoFocus
          >
            {busy ? 'Đang gửi…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
