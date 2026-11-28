/**
 * Screen 33 sheets (FE-09, UC-ADM-08, WF-02 D10): retry an e-invoice that needs review, mark a
 * top-up exception reviewed (after "Kiểm tra lại"), resolve a payment conflict with a note (React
 * Hook Form + Zod, D43). Manual refunds (Khang's #257, BR-P51): ask for a top-up refund by its number
 * or a late-payment refund, then record the gateway refund number, mark it failed with a reason, or
 * redo a failed one. Server errors show as plain Vietnamese inside the sheet (`billingError`).
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type {
  InvoiceNeedsReviewItem,
  LatePaymentItem,
  PaymentConflictItem,
  RefundQueueItem,
  TopUpExceptionItem,
} from '@powerme/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field, FieldError } from '../../components/Field';
import {
  useConfirmRefundMutation,
  useFailRefundMutation,
  useMarkExceptionReviewedMutation,
  useRedoRefundMutation,
  useRefundLatePaymentMutation,
  useRefundTopUpMutation,
  useRetryInvoiceMutation,
  useReviewConflictMutation,
  type ApiError,
} from '../../core/api/api';
import { billingError, ERROR_KIND, EXCEPTION_KIND, REFUND_KIND, vnd } from './format';

type Done = (text: string) => void;

export function RetryInvoiceSheet({
  item,
  onDone,
  onCancel,
}: {
  item: InvoiceNeedsReviewItem;
  onDone: Done;
  onCancel: () => void;
}) {
  const [retry, { isLoading }] = useRetryInvoiceMutation();
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    const res = await retry(item.e_invoice_id);
    if ('error' in res) return setError(billingError(res.error));
    onDone(`Đã gửi lại hoá đơn của lần nạp #${item.top_up_id} (lần ${res.data.attempt_count + 1})`);
  }
  return (
    <ConfirmDialog
      title={`Thử lại hoá đơn lần nạp #${item.top_up_id}`}
      confirmLabel="Thử lại"
      busy={isLoading}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    >
      <p>
        {vnd(item.amount_vnd)} · {item.driver.full_name} · đã thử {item.attempt_count} lần
      </p>
      {item.last_error_kind && (
        <p className="muted small">
          {ERROR_KIND[item.last_error_kind]}: {item.last_error_message ?? '—'}
        </p>
      )}
      <p>Gửi lại nhà cung cấp hoá đơn một lần. Hãy sửa nguyên nhân trước nếu lỗi là do dữ liệu.</p>
      {error && <p className="form-error">{error}</p>}
    </ConfirmDialog>
  );
}

export function ReviewedSheet({
  item,
  onDone,
  onCancel,
}: {
  item: TopUpExceptionItem;
  onDone: Done;
  onCancel: () => void;
}) {
  const [mark, { isLoading }] = useMarkExceptionReviewedMutation();
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    const res = await mark(item.top_up_id);
    if ('error' in res) return setError(billingError(res.error));
    onDone(`Đã đánh dấu đã xem ngoại lệ của lần nạp #${item.top_up_id}`);
  }
  return (
    <ConfirmDialog
      title={`Đánh dấu đã xem lần nạp #${item.top_up_id}`}
      confirmLabel="Đã xem"
      busy={isLoading}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    >
      <p>{EXCEPTION_KIND[item.exception_kind]}</p>
      <p>
        Sau khi đánh dấu, top-up này rời danh sách và không “Kiểm tra lại” được nữa. Hãy kiểm tra
        lại trước nếu chưa làm.
      </p>
      {error && <p className="form-error">{error}</p>}
    </ConfirmDialog>
  );
}

const noteSchema = z.object({
  note: z.string().trim().min(1, 'Nhập cách đã xử lý').max(1000, 'Tối đa 1000 ký tự'),
});
type NoteForm = z.input<typeof noteSchema>;

export function ConflictReviewSheet({
  item,
  onDone,
  onCancel,
}: {
  item: PaymentConflictItem;
  onDone: Done;
  onCancel: () => void;
}) {
  const [review, { isLoading }] = useReviewConflictMutation();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<NoteForm>({
    resolver: zodResolver(noteSchema),
    mode: 'onTouched',
    defaultValues: { note: '' },
  });
  async function onValid(v: NoteForm) {
    const res = await review({ id: item.conflict_id, note: v.note.trim() });
    if ('error' in res)
      return setError('root.server', { type: 'server', message: billingError(res.error) });
    onDone(`Đã ghi nhận xử lý lần trả mâu thuẫn của lần nạp #${item.top_up_id}`);
  }
  return (
    <ConfirmDialog
      title={`Xử lý lần trả mâu thuẫn lần nạp #${item.top_up_id}`}
      confirmLabel="Đã xử lý"
      busy={isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <p>
        {vnd(item.amount_vnd)} · mã giao dịch {item.gateway_transaction_no} · {item.reason}
      </p>
      <p className="muted small">
        Việc xử lý (hoàn tiền, liên hệ VNPay) làm ngoài hệ thống (BR-P13).
      </p>
      <Field label="Ghi chú xử lý (bắt buộc)" error={errors.note?.message}>
        {(a11y) => (
          <textarea {...a11y} {...register('note')} className="input" rows={3} maxLength={1000} />
        )}
      </Field>
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}

const topUpSchema = z.object({
  topUpId: z
    .string()
    .trim()
    .min(1, 'Nhập mã lần nạp')
    .regex(/^\d{1,18}$/, 'Mã lần nạp là một số, ví dụ 1024'),
});
type TopUpForm = z.input<typeof topUpSchema>;

/** Top-up refund by number (no list of refundable top-ups yet): customer service gives the number. */
export function CreateTopUpRefundSheet({
  onDone,
  onCancel,
}: {
  onDone: Done;
  onCancel: () => void;
}) {
  const [refund, { isLoading }] = useRefundTopUpMutation();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<TopUpForm>({
    resolver: zodResolver(topUpSchema),
    mode: 'onTouched',
    defaultValues: { topUpId: '' },
  });
  async function onValid(v: TopUpForm) {
    const id = v.topUpId.trim();
    const res = await refund(id);
    if ('error' in res) {
      const message =
        (res.error as Partial<ApiError>).code === 'not_found'
          ? `Không có lần nạp #${id}`
          : billingError(res.error);
      return setError('root.server', { type: 'server', message });
    }
    onDone(
      `Đã tạo yêu cầu hoàn lần nạp #${id}: CSKH hoàn ${vnd(res.data.amount_vnd)} trên cổng VNPay rồi ghi nhận ở mục Hoàn tiền`,
    );
  }
  return (
    <ConfirmDialog
      title="Tạo yêu cầu hoàn lần nạp"
      confirmLabel="Tạo yêu cầu hoàn"
      danger
      busy={isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <p>
        Số đã nạp bị trừ khỏi ví của tài xế ngay và điểm đã dùng cho lần nạp được trả lại. CSKH hoàn
        tiền trên cổng merchant VNPay, sau đó ghi nhận mã hoàn ở mục Hoàn tiền (BR-P51).
      </p>
      <p className="muted small">
        Chỉ hoàn được khi số dư khả dụng của tài xế (số dư trừ tiền đang giữ cho phiên sạc) còn đủ.
      </p>
      <Field label="Mã lần nạp" error={errors.topUpId?.message}>
        {(a11y) => (
          <input
            {...a11y}
            {...register('topUpId')}
            className="input"
            inputMode="numeric"
            autoComplete="off"
          />
        )}
      </Field>
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}

export function LateRefundSheet({
  item,
  onDone,
  onCancel,
}: {
  item: LatePaymentItem;
  onDone: Done;
  onCancel: () => void;
}) {
  const [refund, { isLoading }] = useRefundLatePaymentMutation();
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    const res = await refund(item.top_up_id);
    if ('error' in res) return setError(billingError(res.error));
    onDone(
      `Đã tạo yêu cầu hoàn khoản trả muộn của lần nạp #${item.top_up_id}: CSKH hoàn ${vnd(res.data.amount_vnd)} trên cổng VNPay`,
    );
  }
  return (
    <ConfirmDialog
      title={`Hoàn khoản trả muộn lần nạp #${item.top_up_id}`}
      confirmLabel="Tạo yêu cầu hoàn"
      busy={isLoading}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    >
      <p>
        {vnd(item.late_amount_vnd)} · {item.driver.full_name} · mã giao dịch {item.late_gateway_ref}
      </p>
      <p>
        Khoản này chưa từng cộng vào ví nên không trừ ví. CSKH hoàn trên cổng merchant VNPay, sau đó
        ghi nhận mã hoàn ở mục Hoàn tiền.
      </p>
      {error && <p className="form-error">{error}</p>}
    </ConfirmDialog>
  );
}

function RefundSummary({ item }: { item: RefundQueueItem }) {
  return (
    <p>
      {REFUND_KIND[item.kind]} #{item.top_up_id} · {vnd(item.amount_vnd)} · {item.driver.full_name}
      {item.gateway_transaction_no && <> · mã giao dịch {item.gateway_transaction_no}</>}
    </p>
  );
}

const refundNoSchema = z.object({
  gatewayRefundNo: z
    .string()
    .trim()
    .min(1, 'Nhập mã hoàn trên cổng VNPay')
    .max(20, 'Tối đa 20 ký tự')
    .regex(/^[A-Za-z0-9._/-]+$/, 'Chỉ gồm chữ không dấu, số và . _ / -'),
});
type RefundNoForm = z.input<typeof refundNoSchema>;

export function ConfirmRefundSheet({
  item,
  onDone,
  onCancel,
}: {
  item: RefundQueueItem;
  onDone: Done;
  onCancel: () => void;
}) {
  const [confirmRefund, { isLoading }] = useConfirmRefundMutation();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RefundNoForm>({
    resolver: zodResolver(refundNoSchema),
    mode: 'onTouched',
    defaultValues: { gatewayRefundNo: '' },
  });
  async function onValid(v: RefundNoForm) {
    const res = await confirmRefund({
      id: item.refund_id,
      gateway_refund_no: v.gatewayRefundNo.trim(),
    });
    if ('error' in res)
      return setError('root.server', { type: 'server', message: billingError(res.error) });
    onDone(
      res.data.already_done
        ? `Hoàn tiền lần nạp #${item.top_up_id} đã được ghi nhận trước đó với mã ${res.data.gateway_refund_no}`
        : `Đã ghi nhận hoàn ${vnd(item.amount_vnd)} cho lần nạp #${item.top_up_id} (mã ${res.data.gateway_refund_no})`,
    );
  }
  return (
    <ConfirmDialog
      title={`Ghi nhận đã hoàn lần nạp #${item.top_up_id}`}
      confirmLabel="Đã hoàn"
      busy={isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <RefundSummary item={item} />
      <p className="muted small">
        Nhập mã giao dịch hoàn mà cổng merchant VNPay trả về. Mỗi mã chỉ ghi được một lần; ghi xong
        hệ thống phát hành hoá đơn điều chỉnh và báo cho tài xế.
      </p>
      <Field label="Mã hoàn trên cổng" error={errors.gatewayRefundNo?.message}>
        {(a11y) => (
          <input
            {...a11y}
            {...register('gatewayRefundNo')}
            className="input"
            maxLength={40}
            autoComplete="off"
          />
        )}
      </Field>
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}

const reasonSchema = z.object({
  reason: z.string().trim().min(1, 'Nhập lý do cổng từ chối').max(1000, 'Tối đa 1000 ký tự'),
});
type ReasonForm = z.input<typeof reasonSchema>;

export function FailRefundSheet({
  item,
  onDone,
  onCancel,
}: {
  item: RefundQueueItem;
  onDone: Done;
  onCancel: () => void;
}) {
  const [fail, { isLoading }] = useFailRefundMutation();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ReasonForm>({
    resolver: zodResolver(reasonSchema),
    mode: 'onTouched',
    defaultValues: { reason: '' },
  });
  async function onValid(v: ReasonForm) {
    const res = await fail({ id: item.refund_id, reason: v.reason.trim() });
    if ('error' in res)
      return setError('root.server', { type: 'server', message: billingError(res.error) });
    onDone(`Đã ghi nhận cổng từ chối hoàn lần nạp #${item.top_up_id}`);
  }
  return (
    <ConfirmDialog
      title={`Cổng từ chối hoàn lần nạp #${item.top_up_id}`}
      confirmLabel="Ghi nhận thất bại"
      danger
      busy={isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <RefundSummary item={item} />
      <p className="muted small">
        Số tiền vẫn nằm ở yêu cầu hoàn, không quay về ví. Có thể “Làm lại” sau khi xử lý nguyên
        nhân.
      </p>
      <Field label="Lý do (bắt buộc)" error={errors.reason?.message}>
        {(a11y) => (
          <textarea {...a11y} {...register('reason')} className="input" rows={3} maxLength={1000} />
        )}
      </Field>
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}

export function RedoRefundSheet({
  item,
  onDone,
  onCancel,
}: {
  item: RefundQueueItem;
  onDone: Done;
  onCancel: () => void;
}) {
  const [redo, { isLoading }] = useRedoRefundMutation();
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    const res = await redo(item.refund_id);
    if ('error' in res) return setError(billingError(res.error));
    onDone(`Yêu cầu hoàn lần nạp #${item.top_up_id} đã quay lại danh sách chờ CSKH`);
  }
  return (
    <ConfirmDialog
      title={`Làm lại hoàn lần nạp #${item.top_up_id}`}
      confirmLabel="Làm lại"
      busy={isLoading}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    >
      <RefundSummary item={item} />
      {item.failure_reason && <p className="muted small">Lần trước: {item.failure_reason}</p>}
      <p>Yêu cầu quay về “Chờ hoàn” để CSKH hoàn lại trên cổng VNPay.</p>
      {error && <p className="form-error">{error}</p>}
    </ConfirmDialog>
  );
}
