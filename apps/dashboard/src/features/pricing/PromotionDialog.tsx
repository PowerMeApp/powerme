/**
 * Create or edit a promotion (screen 24, FE-06, UC-OPS-07). React Hook Form + Zod (D43): errors in
 * red under each field; a taken code (409) shows under the code. The code cannot change when editing.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import type { Promotion } from '@powerme/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field, FieldError } from '../../components/Field';
import {
  useCreatePromotionMutation,
  useUpdatePromotionMutation,
  type ApiError,
} from '../../core/api/api';
import { pricingError, toLocalInput } from './format';
import { promotionSchema, type PromotionForm, type PromotionValues } from './schema';

export function PromotionDialog({
  promotion,
  onDone,
  onCancel,
}: {
  /** Edit this one; undefined = create. */
  promotion?: Promotion;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const [create, c] = useCreatePromotionMutation();
  const [update, u] = useUpdatePromotionMutation();
  const editing = !!promotion;
  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<PromotionForm, unknown, PromotionValues>({
    resolver: zodResolver(promotionSchema),
    mode: 'onTouched',
    defaultValues: promotion
      ? {
          promotion_code: promotion.promotion_code,
          discount_type: promotion.discount_type,
          discount_value: String(promotion.discount_value),
          valid_from: toLocalInput(promotion.valid_from),
          valid_to: toLocalInput(promotion.valid_to),
        }
      : {
          promotion_code: '',
          discount_type: 'percent',
          discount_value: '',
          valid_from: '',
          valid_to: '',
        },
  });
  const percent = watch('discount_type') === 'percent';

  async function onValid(v: PromotionValues) {
    const body = {
      discount_type: v.discount_type,
      discount_value: Number(v.discount_value),
      valid_from: new Date(v.valid_from).toISOString(),
      valid_to: new Date(v.valid_to).toISOString(),
    };
    const res = editing
      ? await update({ id: promotion.id, ...body })
      : await create({ promotion_code: v.promotion_code, ...body });
    if ('error' in res) {
      const taken = (res.error as ApiError).code === 'promotion_code_taken';
      return setError(taken ? 'promotion_code' : 'root.server', {
        type: 'server',
        message: pricingError(res.error),
      });
    }
    onDone(
      editing
        ? `Đã cập nhật khuyến mãi ${v.promotion_code}`
        : `Đã tạo khuyến mãi ${v.promotion_code}`,
    );
  }

  return (
    <ConfirmDialog
      title={editing ? `Sửa khuyến mãi ${promotion.promotion_code}` : 'Tạo khuyến mãi'}
      confirmLabel={editing ? 'Lưu' : 'Tạo'}
      busy={c.isLoading || u.isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <Field label="Mã khuyến mãi" error={errors.promotion_code?.message}>
        {(a11y) => (
          <input
            {...a11y}
            {...register('promotion_code', {
              setValueAs: (v: string) => v.toUpperCase(),
            })}
            className="input"
            maxLength={30}
            placeholder="VD: TET2027"
            disabled={editing}
          />
        )}
      </Field>
      <Field label="Loại giảm giá">
        {(a11y) => (
          <select {...a11y} {...register('discount_type')} className="input">
            <option value="percent">Phần trăm (%)</option>
            <option value="fixed_vnd">Số tiền cố định (₫)</option>
          </select>
        )}
      </Field>
      <Field label={percent ? 'Giá trị (%)' : 'Giá trị (₫)'} error={errors.discount_value?.message}>
        {(a11y) => (
          <input {...a11y} {...register('discount_value')} className="input" inputMode="numeric" />
        )}
      </Field>
      <Field label="Bắt đầu" error={errors.valid_from?.message}>
        {(a11y) => (
          <input {...a11y} {...register('valid_from')} className="input" type="datetime-local" />
        )}
      </Field>
      <Field label="Kết thúc" error={errors.valid_to?.message}>
        {(a11y) => (
          <input {...a11y} {...register('valid_to')} className="input" type="datetime-local" />
        )}
      </Field>
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}
