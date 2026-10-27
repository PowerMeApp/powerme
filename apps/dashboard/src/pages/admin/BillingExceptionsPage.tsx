/**
 * Screen 31 — Billing Exceptions (UC-ADM-08). Thiết kế: docs/UC-ADM-08-BILLING-EXCEPTIONS.md,
 * sequence 1–3 (uc-adm-08-seq-*), SD-2b/2c, STM-4/7, BR-P13/P21/P44.
 *
 * Bốn hàng đợi theo SRS screen 31 (tin nhắn của lead nói 3 tab — tab 4 "tài khoản đã đóng" gắn
 * nhãn chờ xác nhận). Mỗi hành động có tiền đi qua hộp xác nhận ghi rõ số tiền và tham chiếu; nút
 * xác nhận khoá khi đang gửi (một lần bấm = một request).
 */
import { useState } from 'react';
import { ConfirmDialog, Empty, Loading, PageHeader, Pill, Tabs } from '../../components/ui';
import {
  errorMessage,
  useAdminSummaryQuery,
  useClosedAccountsQuery,
  useClosureRefundMutation,
  useLatePaymentsQuery,
  useNeedsReviewInvoicesQuery,
  useRefundableTopUpsQuery,
  useRefundLatePaymentMutation,
  useRefundTopUpMutation,
  useRetryInvoiceMutation,
} from '../../core/api/api';
import { splitClosureRefund } from '../../features/billing/rules';
import { useToast } from '../../hooks/toast';
import type {
  ClosedAccountRefund,
  LatePayment,
  NeedsReviewInvoice,
  RefundableTopUp,
} from '../../types/domain';
import { formatDateTime, formatVnd, timeAgo } from '../../utils/format';

type Tab = 'topups' | 'late' | 'invoices' | 'closed';

function TopUpsTab() {
  const toast = useToast();
  const { data, isLoading } = useRefundableTopUpsQuery();
  const [refund, { isLoading: busy }] = useRefundTopUpMutation();
  const [target, setTarget] = useState<RefundableTopUp | null>(null);
  if (isLoading) return <Loading />;
  if (!data?.items.length) return <Empty title="Không có top-up nào cần xử lý" />;
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Tài xế</th>
            <th>Mã giao dịch</th>
            <th className="num">Top-up</th>
            <th className="num">Đã thu</th>
            <th className="num">Điểm dùng</th>
            <th>Credited</th>
            <th className="num">Số dư hiện tại</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((t) => (
            <tr key={t.id}>
              <td>{t.driverName}</td>
              <td className="mono">{t.gatewayRef}</td>
              <td className="num">{formatVnd(t.amountVnd)}</td>
              <td className="num">{formatVnd(t.amountPaidVnd)}</td>
              <td className="num">{t.pointsRedeemed || '—'}</td>
              <td>{formatDateTime(t.completedAt)}</td>
              <td className="num">{formatVnd(t.balanceVnd)}</td>
              <td>
                <button
                  type="button"
                  className="btn small gold"
                  disabled={!t.refundable}
                  title={
                    t.refundable
                      ? undefined
                      : 'Số dư thấp hơn số tiền top-up — không hoàn một phần (BR-P21)'
                  }
                  onClick={() => setTarget(t)}
                >
                  Hoàn tiền
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {target && (
        <ConfirmDialog
          title="Hoàn top-up?"
          confirmLabel="Hoàn tiền"
          tone="gold"
          busy={busy}
          onCancel={() => setTarget(null)}
          onConfirm={async () => {
            const r = await refund(target.id);
            if ('error' in r) toast.error(errorMessage(r.error));
            else
              toast.success(
                `Đã hoàn ${formatVnd(r.data.refundedVnd)} cho ${target.driverName}` +
                  (r.data.pointsRestored ? ` · trả lại ${r.data.pointsRestored} điểm` : ''),
              );
            setTarget(null);
          }}
        >
          <p>
            Hoàn <b>{formatVnd(target.amountPaidVnd)}</b> về nguồn thanh toán gốc của{' '}
            {target.driverName} ({target.gatewayRef})
            {target.pointsRedeemed ? `, trả lại ${target.pointsRedeemed} điểm` : ''}. Credit giảm{' '}
            {formatVnd(target.amountVnd)}; hệ thống lập hoá đơn điều chỉnh, hoá đơn gốc giữ nguyên.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function LateTab() {
  const toast = useToast();
  const { data, isLoading } = useLatePaymentsQuery();
  const [refund, { isLoading: busy }] = useRefundLatePaymentMutation();
  const [target, setTarget] = useState<LatePayment | null>(null);
  if (isLoading) return <Loading />;
  if (!data?.items.length) return <Empty title="Không có thanh toán trễ nào" />;
  return (
    <div className="card table-wrap">
      <p className="muted" style={{ marginTop: 0 }}>
        Thanh toán đến sau cửa sổ 1 giờ kể từ khi top-up hết hạn: không được cộng credit, phải hoàn
        về nguồn (BR-P13, SD-2c pha D).
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Tài xế</th>
            <th>Mã VNPay</th>
            <th className="num">Số tiền</th>
            <th>Thanh toán lúc</th>
            <th>Top-up hết hạn</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((l) => (
            <tr key={l.id}>
              <td>{l.driverName}</td>
              <td className="mono">{l.lateGatewayRef}</td>
              <td className="num">{formatVnd(l.lateAmountVnd)}</td>
              <td>
                {formatDateTime(l.latePaidAt)}
                <div className="hint">{timeAgo(l.latePaidAt)}</div>
              </td>
              <td>{formatDateTime(l.expiresAt)}</td>
              <td>
                <button type="button" className="btn small gold" onClick={() => setTarget(l)}>
                  Hoàn thanh toán trễ
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {target && (
        <ConfirmDialog
          title="Hoàn thanh toán trễ?"
          confirmLabel="Hoàn tiền"
          tone="gold"
          busy={busy}
          onCancel={() => setTarget(null)}
          onConfirm={async () => {
            const r = await refund(target.id);
            if ('error' in r) toast.error(errorMessage(r.error));
            else
              toast.success(
                `Đã hoàn ${formatVnd(target.lateAmountVnd)} (${target.lateGatewayRef})`,
              );
            setTarget(null);
          }}
        >
          <p>
            Hoàn <b>{formatVnd(target.lateAmountVnd)}</b> qua VNPay cho giao dịch{' '}
            <span className="mono">{target.lateGatewayRef}</span>. Top-up vẫn ở trạng thái hết hạn;
            không ghi sổ credit.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function InvoicesTab() {
  const toast = useToast();
  const { data, isLoading } = useNeedsReviewInvoicesQuery();
  const [retry, { isLoading: busy }] = useRetryInvoiceMutation();
  const [target, setTarget] = useState<NeedsReviewInvoice | null>(null);
  if (isLoading) return <Loading />;
  if (!data?.items.length) return <Empty title="Không có hoá đơn nào chờ xử lý" />;
  return (
    <div className="card table-wrap">
      <p className="muted" style={{ marginTop: 0 }}>
        Lỗi tạm thời đã tự thử lại 3 lần; lỗi bị nhà cung cấp từ chối chuyển thẳng vào đây. Sửa
        nguyên nhân rồi thử lại từng lần một — không bao giờ sửa hoá đơn đã phát hành (BR-P44).
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Hoá đơn</th>
            <th>Tài xế</th>
            <th className="num">Số tiền</th>
            <th className="num">Số lần</th>
            <th>Lỗi gần nhất</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((i) => (
            <tr key={i.id}>
              <td className="mono">
                #{i.id}
                <div className="hint">top-up #{i.topUpId}</div>
              </td>
              <td>{i.driverName}</td>
              <td className="num">{formatVnd(i.amountVnd)}</td>
              <td className="num">{i.attemptCount}</td>
              <td style={{ maxWidth: 340 }}>
                <Pill tone={i.lastErrorKind === 'rejected' ? 'danger' : 'warning'}>
                  {i.lastErrorKind === 'rejected' ? 'Bị từ chối' : 'Tạm thời'}
                </Pill>
                <div className="hint" title={i.lastErrorMessage}>
                  {i.lastErrorMessage}
                </div>
              </td>
              <td>
                <button type="button" className="btn small primary" onClick={() => setTarget(i)}>
                  Thử lại
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {target && (
        <ConfirmDialog
          title={`Thử lại hoá đơn #${target.id}?`}
          confirmLabel="Thử lại một lần"
          busy={busy}
          onCancel={() => setTarget(null)}
          onConfirm={async () => {
            const r = await retry(target.id);
            if ('error' in r) toast.error(errorMessage(r.error));
            else if (r.data.status === 'issued') toast.success(`Đã phát hành ${r.data.invoiceNo}`);
            else toast.warning(`Vẫn lỗi (lần ${r.data.attemptCount}): ${r.data.lastErrorMessage}`);
            setTarget(null);
          }}
        >
          <p>
            Gửi lại hoá đơn {formatVnd(target.amountVnd)} cho {target.driverName} tới nhà cung cấp.
            Credit của tài xế không bị ảnh hưởng dù kết quả thế nào.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ClosedAccountsTab() {
  const toast = useToast();
  const { data, isLoading } = useClosedAccountsQuery();
  const [refund, { isLoading: busy }] = useClosureRefundMutation();
  const [target, setTarget] = useState<ClosedAccountRefund | null>(null);
  if (isLoading) return <Loading />;
  return (
    <>
      <div className="banner">
        Hàng đợi này có trong SRS screen 31 / UC-ADM-08 nhưng không có trong yêu cầu 3 tab —{' '}
        <b>chờ xác nhận phạm vi</b>.
      </div>
      {!data?.items.length ? (
        <Empty title="Không có tài khoản nào chờ hoàn" />
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tài xế</th>
                <th>Đóng lúc</th>
                <th className="num">Số dư chưa dùng</th>
                <th>Hoàn về (mới nhất trước)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => {
                const split = splitClosureRefund(
                  c.unusedBalanceVnd,
                  c.sources.map((s) => ({ topUpId: s.topUpId, amountPaidVnd: s.amountVnd })),
                );
                return (
                  <tr key={c.id}>
                    <td>{c.driverName}</td>
                    <td>{formatDateTime(c.closedAt)}</td>
                    <td className="num">{formatVnd(c.unusedBalanceVnd)}</td>
                    <td>
                      {split.allocations.map((a) => {
                        const src = c.sources.find((s) => s.topUpId === a.topUpId);
                        return (
                          <div key={a.topUpId} className="mono">
                            {src?.gatewayRef} · {formatVnd(a.amountVnd)}
                          </div>
                        );
                      })}
                    </td>
                    <td>
                      <button type="button" className="btn small gold" onClick={() => setTarget(c)}>
                        Hoàn số dư
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {target && (
        <ConfirmDialog
          title="Hoàn số dư cho tài khoản đã đóng?"
          confirmLabel="Hoàn số dư"
          tone="gold"
          busy={busy}
          onCancel={() => setTarget(null)}
          onConfirm={async () => {
            const r = await refund(target.id);
            if ('error' in r) toast.error(errorMessage(r.error));
            else
              toast.success(
                `Đã hoàn ${formatVnd(target.unusedBalanceVnd)} cho ${target.driverName}`,
              );
            setTarget(null);
          }}
        >
          <p>
            Hoàn <b>{formatVnd(target.unusedBalanceVnd)}</b> về nguồn của các top-up gần nhất
            (BR-P21), mỗi khoản một hoá đơn điều chỉnh.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

export function BillingExceptionsPage() {
  const [tab, setTab] = useState<Tab>('topups');
  const { data } = useAdminSummaryQuery();
  const b = data?.billingExceptions;
  return (
    <>
      <PageHeader
        title="Ngoại lệ thanh toán"
        subtitle="Hoàn top-up, hoàn thanh toán trễ, thử lại hoá đơn điện tử (UC-ADM-08)"
      />
      <Tabs
        tabs={[
          { id: 'topups', label: 'Top-up để hoàn', badge: b?.topUps },
          { id: 'late', label: 'Thanh toán trễ', badge: b?.latePayments },
          { id: 'invoices', label: 'Hoá đơn cần xử lý', badge: b?.invoices },
          { id: 'closed', label: 'Tài khoản đã đóng', badge: b?.closedAccounts },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'topups' && <TopUpsTab />}
      {tab === 'late' && <LateTab />}
      {tab === 'invoices' && <InvoicesTab />}
      {tab === 'closed' && <ClosedAccountsTab />}
    </>
  );
}
