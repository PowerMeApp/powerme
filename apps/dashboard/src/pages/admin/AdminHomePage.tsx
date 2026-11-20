/**
 * Screen 27 — Admin Dashboard (hub, FE-14, UC-ADM-07). Greeting from /me, then the platform counts
 * from GET /api/admin/v1/summary: user accounts by role, charge points by lifecycle and online,
 * RFID cards by status. A group that is 0 is hidden — never a placeholder (D36). The billing
 * exceptions tile comes with FE-09 (screen 32), although the API already returns its counts.
 * Links to each Admin screen are added as those screens land. Polled every 10 s.
 */
import type { AdminSummary, ChargePointLifecycle } from '@powerme/shared';
import { errorMessage, useAdminMeQuery, useAdminSummaryQuery } from '../../core/api/api';
import { LIFECYCLE } from '../../features/chargePoints/format';

export const ADMIN_SUMMARY_POLL_MS = 10_000;

const USER_GROUPS: [keyof AdminSummary['users'], string, string][] = [
  ['driver', 'Tài xế', ''],
  ['operator_staff', 'Nhân viên Operator', ''],
  ['admin', 'Admin', ''],
  ['suspended', 'Đang bị khoá', 'major'],
];
const CARD_GROUPS: [keyof AdminSummary['rfid_cards'], string, string][] = [
  ['active', 'Đang dùng', ''],
  ['unlinked', 'Chưa gắn tài xế', 'muted'],
  ['blocked', 'Bị chặn', 'major'],
];
const LIFECYCLE_ORDER: ChargePointLifecycle[] = [
  'registered',
  'awaiting_connection',
  'in_service',
  'disabled',
  'decommissioned',
];

function Counts<K extends string>({
  rows,
  values,
}: {
  rows: [K, string, string][];
  values: Partial<Record<K, number>>;
}) {
  return (
    <ul className="tile-list">
      {rows
        .filter(([k]) => (values[k] ?? 0) > 0)
        .map(([k, label, tone]) => (
          <li key={k}>
            <span className={`pill ${tone}`}>{label}</span> <b>{values[k]}</b>
          </li>
        ))}
    </ul>
  );
}

export function AdminHomePage() {
  const me = useAdminMeQuery();
  const summary = useAdminSummaryQuery(undefined, {
    pollingInterval: ADMIN_SUMMARY_POLL_MS,
    skipPollingIfUnfocused: true,
  });
  const s = summary.data;
  const users = s ? s.users.driver + s.users.operator_staff + s.users.admin : 0;
  const lifecycles = s
    ? LIFECYCLE_ORDER.filter((l) => (s.charge_points.by_lifecycle[l] ?? 0) > 0)
    : [];
  const chargePoints = s ? lifecycles.reduce((n, l) => n + s.charge_points.by_lifecycle[l]!, 0) : 0;
  const cards = s ? s.rfid_cards.active + s.rfid_cards.blocked + s.rfid_cards.unlinked : 0;
  const inService = s?.charge_points.by_lifecycle.in_service ?? 0;

  return (
    <>
      <div className="page-head">
        <h1>Tổng quan nền tảng</h1>
      </div>
      <div className="card">
        {me.isLoading && <p className="muted">Đang tải…</p>}
        {me.error && <p role="alert">{errorMessage(me.error)}</p>}
        {me.data && <p>Xin chào {me.data.full_name}. Bạn đang quản trị toàn nền tảng PowerMe.</p>}
      </div>
      {summary.error && !s && <p role="alert">{errorMessage(summary.error)}</p>}
      {s && users + chargePoints + cards === 0 && (
        <p className="muted">Nền tảng chưa có tài khoản, Charge Point hay thẻ RFID nào.</p>
      )}
      {s && (
        <div className="tiles">
          {users > 0 && (
            <section className="card tile" aria-label="Tài khoản">
              <h2>Tài khoản</h2>
              <p className="tile-number">{users}</p>
              <Counts rows={USER_GROUPS} values={s.users} />
            </section>
          )}
          {chargePoints > 0 && (
            <section className="card tile" aria-label="Charge Point">
              <h2>Charge Point</h2>
              <p className="tile-number">
                {chargePoints}
                {inService > 0 && (
                  <span className="muted">
                    {' '}
                    · {s.charge_points.online} / {inService} đang hoạt động online
                  </span>
                )}
              </p>
              <Counts
                rows={lifecycles.map((l) => [
                  l,
                  LIFECYCLE[l],
                  l === 'decommissioned' ? 'muted' : '',
                ])}
                values={s.charge_points.by_lifecycle}
              />
            </section>
          )}
          {cards > 0 && (
            <section className="card tile" aria-label="Thẻ RFID">
              <h2>Thẻ RFID</h2>
              <p className="tile-number">{cards}</p>
              <Counts rows={CARD_GROUPS} values={s.rfid_cards} />
            </section>
          )}
        </div>
      )}
    </>
  );
}
