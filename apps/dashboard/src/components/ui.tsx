/**
 * Thành phần giao diện dùng chung (PKG-2: components). Tên và hình dáng bám theo widget của app
 * Flutter: StatusPill (pill bo tròn nền 12 %), AppScaffold (thẻ Graphite bo 20 px).
 */
import { ReactNode, useEffect, useRef } from 'react';
import type { ConnectorStatus, FaultSeverity, FaultStatus } from '../types/domain';
import { FAULT_STATUS_LABEL } from '../features/alerts/faultStateMachine';
import { SEVERITY_LABEL } from '../features/alerts/errorCodeGuide';

export type Tone = 'teal' | 'gold' | 'danger' | 'warning' | 'muted';

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

const CONNECTOR_TONE: Record<ConnectorStatus, Tone> = {
  Available: 'teal',
  Preparing: 'gold',
  Charging: 'gold',
  SuspendedEV: 'warning',
  SuspendedEVSE: 'warning',
  Finishing: 'gold',
  Reserved: 'gold',
  Unavailable: 'muted',
  Faulted: 'danger',
};

const CONNECTOR_LABEL: Record<ConnectorStatus, string> = {
  Available: 'Sẵn sàng',
  Preparing: 'Chuẩn bị',
  Charging: 'Đang sạc',
  SuspendedEV: 'Xe tạm dừng',
  SuspendedEVSE: 'Trụ tạm dừng',
  Finishing: 'Kết thúc',
  Reserved: 'Đã giữ chỗ',
  Unavailable: 'Không khả dụng',
  Faulted: 'Lỗi',
};

export function ConnectorPill({ status }: { status: ConnectorStatus }) {
  return <Pill tone={CONNECTOR_TONE[status]}>{CONNECTOR_LABEL[status]}</Pill>;
}

const FAULT_TONE: Record<FaultStatus, Tone> = {
  raised: 'danger',
  acknowledged: 'warning',
  resetting: 'gold',
  resolved: 'teal',
};

export function FaultStatusPill({ status }: { status: FaultStatus }) {
  return <Pill tone={FAULT_TONE[status]}>{FAULT_STATUS_LABEL[status]}</Pill>;
}

const SEVERITY_TONE: Record<FaultSeverity, Tone> = {
  critical: 'danger',
  major: 'warning',
  minor: 'teal',
  none: 'muted',
};

export function SeverityPill({ severity }: { severity: FaultSeverity }) {
  return <Pill tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Pill>;
}

export function Card({
  title,
  extra,
  children,
  className = '',
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <h2>
          {title}
          {extra}
        </h2>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  crumb,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  crumb?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {crumb && <div className="crumb">{crumb}</div>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'teal' | 'gold' | 'danger';
}) {
  return (
    <div className={`card stat ${tone ?? ''}`}>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Loading() {
  return <div className="empty">Đang tải…</div>;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; badge?: number }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          className="tab"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge ? <span className="badge">{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Hộp thoại xác nhận cho mọi hành động có tiền hoặc tác động lên trụ. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  tone = 'primary',
  busy,
  onConfirm,
  onCancel,
  extra,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'gold' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
  return (
    <div className="overlay" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <div>{children}</div>
        {extra}
        <div className="btn-row">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Huỷ
          </button>
          <button
            ref={ref}
            type="button"
            className={`btn ${tone}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Đang gửi…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sheet-overlay" role="presentation" onClick={onClose}>
      <aside
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="page-head">
          <h1 style={{ fontSize: 22 }}>{title}</h1>
          <div className="actions">
            <button type="button" className="btn ghost small" onClick={onClose}>
              Đóng
            </button>
          </div>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function ShouldBanner({ children }: { children?: ReactNode }) {
  return (
    <div className="banner">
      Màn hình «Should» theo SRS — dựng khung để duyệt luồng, chưa phải phạm vi Must.
      {children}
    </div>
  );
}
