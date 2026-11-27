/**
 * Screen 33 sheets (FE-09, UC-ADM-08, WF-02 D10): retry an e-invoice that needs review, mark a
 * top-up exception reviewed (after "Kiểm tra lại"), resolve a payment conflict with a note (React
 * Hook Form + Zod, D43). Refund actions (create, confirm with refund number, mark failed) come with
 * T152.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type {
  InvoiceNeedsReviewItem,
  PaymentConflictItem,
  TopUpExceptionItem,
} from '@powerme/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field, FieldError } from '../../components/Field';
import {
  useMarkExceptionReviewedMutation,
  useRetryInvoiceMutation,
  useReviewConflictMutation,
} from '../../core/api/api';
import { billingError, ERROR_KIND, EXCEPTION_KIND, vnd } from './format';

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
    onDone(`Đã gửi lại hoá đơn của top-up #${item.top_up_id} (lần ${res.data.attempt_count + 1})`);
  }
  return (
    <ConfirmDialog
      title={`Thử lại hoá đơn top-up #${item.top_up_id}`}
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
    onDone(`Đã đánh dấu đã xem ngoại lệ của top-up #${item.top_up_id}`);
  }
  return (
    <ConfirmDialog
      title={`Đánh dấu đã xem top-up #${item.top_up_id}`}
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
    onDone(`Đã ghi nhận xử lý lần trả mâu thuẫn của top-up #${item.top_up_id}`);
  }
  return (
    <ConfirmDialog
      title={`Xử lý lần trả mâu thuẫn top-up #${item.top_up_id}`}
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
