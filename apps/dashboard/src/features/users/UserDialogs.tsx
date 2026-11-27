/**
 * Screen 28 dialogs (FE-19, UC-ADM-01/02): create, edit, change role, lock / unlock. React Hook
 * Form + Zod (D43): each error in red under its field; a server refusal about one field (email or
 * phone taken, unknown Operator) goes under that field, others above the buttons.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import type { PlatformOperator, UserAccount } from '@powerme/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field, FieldError } from '../../components/Field';
import {
  useCreateUserMutation,
  useSetUserLockMutation,
  useSetUserRoleMutation,
  useUpdateUserMutation,
} from '../../core/api/api';
import { STAFF_ROLE, userError, userErrorField } from './format';
import {
  createUserSchema,
  editUserSchema,
  noteSchema,
  roleSchema,
  type CreateUserForm,
  type CreateUserValues,
  type EditUserForm,
  type NoteForm,
  type RoleForm,
  type RoleValues,
} from './schema';

type Done = (text: string) => void;

function OperatorFields({
  operators,
  register,
  error,
}: {
  operators: PlatformOperator[];
  register: (name: 'operator_id' | 'staff_role') => object;
  error: string | undefined;
}) {
  return (
    <>
      <Field label="Operator" error={error}>
        {(a11y) => (
          <select {...a11y} {...register('operator_id')} className="input">
            <option value="">— Chọn Operator —</option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.legal_name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Chức vụ">
        {(a11y) => (
          <select {...a11y} {...register('staff_role')} className="input">
            {(Object.keys(STAFF_ROLE) as (keyof typeof STAFF_ROLE)[]).map((r) => (
              <option key={r} value={r}>
                {STAFF_ROLE[r]}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}

export function CreateUserDialog({
  operators,
  onDone,
  onCancel,
}: {
  operators: PlatformOperator[];
  onDone: Done;
  onCancel: () => void;
}) {
  const [create, { isLoading }] = useCreateUserMutation();
  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<CreateUserForm, unknown, CreateUserValues>({
    resolver: zodResolver(createUserSchema),
    mode: 'onTouched',
    defaultValues: {
      email: '',
      full_name: '',
      phone_number: '',
      initial_password: '',
      role: 'operator_staff',
      operator_id: '',
      staff_role: 'technician',
    },
  });
  const staff = watch('role') === 'operator_staff';

  async function onValid(v: CreateUserValues) {
    const base = {
      email: v.email,
      full_name: v.full_name,
      initial_password: v.initial_password,
      ...(v.phone_number ? { phone_number: v.phone_number } : {}),
    };
    const res = await create(
      v.role === 'admin'
        ? { ...base, role: 'admin' }
        : { ...base, role: 'operator_staff', operator_id: v.operator_id, staff_role: v.staff_role },
    );
    if ('error' in res)
      return setError(userErrorField(res.error) ?? 'root.server', {
        type: 'server',
        message: userError(res.error),
      });
    onDone(`Đã tạo tài khoản ${v.email}`);
  }

  return (
    <ConfirmDialog
      title="Tạo tài khoản"
      confirmLabel="Tạo"
      busy={isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <Field label="Vai trò">
        {(a11y) => (
          <select {...a11y} {...register('role')} className="input">
            <option value="operator_staff">Nhân viên Operator</option>
            <option value="admin">Admin</option>
          </select>
        )}
      </Field>
      {staff && (
        <OperatorFields
          operators={operators}
          register={register as never}
          error={errors.operator_id?.message}
        />
      )}
      <Field label="Email" error={errors.email?.message}>
        {(a11y) => <input {...a11y} {...register('email')} className="input" type="email" />}
      </Field>
      <Field label="Họ tên" error={errors.full_name?.message}>
        {(a11y) => <input {...a11y} {...register('full_name')} className="input" />}
      </Field>
      <Field label="Số điện thoại (tuỳ chọn)" error={errors.phone_number?.message}>
        {(a11y) => (
          <input {...a11y} {...register('phone_number')} className="input" inputMode="tel" />
        )}
      </Field>
      <Field label="Mật khẩu ban đầu" error={errors.initial_password?.message}>
        {(a11y) => (
          <input
            {...a11y}
            {...register('initial_password')}
            className="input"
            type="password"
            autoComplete="new-password"
          />
        )}
      </Field>
      <p className="muted small">Mật khẩu ban đầu được giao cho người dùng ngoài hệ thống.</p>
      <p className="muted small">Tài xế tự đăng ký trên ứng dụng nên không tạo ở đây.</p>
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}

export function EditUserDialog({
  user,
  onDone,
  onCancel,
}: {
  user: UserAccount;
  onDone: Done;
  onCancel: () => void;
}) {
  const [update, { isLoading }] = useUpdateUserMutation();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<EditUserForm>({
    resolver: zodResolver(editUserSchema),
    mode: 'onTouched',
    defaultValues: { full_name: user.full_name, phone_number: user.phone_number ?? '' },
  });

  async function onValid(v: EditUserForm) {
    const res = await update({
      id: user.id,
      full_name: v.full_name.trim(),
      phone_number: v.phone_number.trim() || null,
    });
    if ('error' in res)
      return setError(
        userErrorField(res.error) === 'phone_number' ? 'phone_number' : 'root.server',
        {
          type: 'server',
          message: userError(res.error),
        },
      );
    onDone(`Đã cập nhật tài khoản ${user.email}`);
  }

  return (
    <ConfirmDialog
      title={`Sửa tài khoản ${user.email}`}
      confirmLabel="Lưu"
      busy={isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <Field label="Họ tên" error={errors.full_name?.message}>
        {(a11y) => <input {...a11y} {...register('full_name')} className="input" />}
      </Field>
      <Field label="Số điện thoại (để trống để xoá)" error={errors.phone_number?.message}>
        {(a11y) => (
          <input {...a11y} {...register('phone_number')} className="input" inputMode="tel" />
        )}
      </Field>
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}

export function RoleDialog({
  user,
  operators,
  onDone,
  onCancel,
}: {
  user: UserAccount;
  operators: PlatformOperator[];
  onDone: Done;
  onCancel: () => void;
}) {
  const [setRole, { isLoading }] = useSetUserRoleMutation();
  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<RoleForm, unknown, RoleValues>({
    resolver: zodResolver(roleSchema),
    mode: 'onTouched',
    defaultValues: {
      role: user.role === 'admin' ? 'admin' : 'operator_staff',
      operator_id: user.operator?.id ?? '',
      staff_role: user.staff_role ?? 'technician',
    },
  });
  const staff = watch('role') === 'operator_staff';

  async function onValid(v: RoleValues) {
    const res = await setRole({
      id: user.id,
      body:
        v.role === 'admin'
          ? { role: 'admin' }
          : { role: 'operator_staff', operator_id: v.operator_id, staff_role: v.staff_role },
    });
    if ('error' in res)
      return setError(userErrorField(res.error) === 'operator_id' ? 'operator_id' : 'root.server', {
        type: 'server',
        message: userError(res.error),
      });
    onDone(`Đã đổi vai trò của ${user.email}`);
  }

  return (
    <ConfirmDialog
      title={`Đổi vai trò ${user.email}`}
      confirmLabel="Đổi vai trò"
      busy={isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <p>
        Mỗi tài khoản chỉ có một vai trò. Phiên đăng nhập hiện tại của người này sẽ hết hiệu lực.
      </p>
      <Field label="Vai trò">
        {(a11y) => (
          <select {...a11y} {...register('role')} className="input">
            <option value="operator_staff">Nhân viên Operator</option>
            <option value="admin">Admin</option>
          </select>
        )}
      </Field>
      {staff && (
        <OperatorFields
          operators={operators}
          register={register as never}
          error={errors.operator_id?.message}
        />
      )}
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}

export function LockDialog({
  user,
  onDone,
  onCancel,
  onStale,
}: {
  user: UserAccount;
  onDone: Done;
  onCancel: () => void;
  onStale: () => void;
}) {
  const lock = user.account_status === 'active';
  const [setLock, { isLoading }] = useSetUserLockMutation();
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
    const res = await setLock({ id: user.id, lock, note: v.note.trim() });
    if ('error' in res) {
      onStale();
      return setError('root.server', { type: 'server', message: userError(res.error) });
    }
    onDone(lock ? `Đã khoá tài khoản ${user.email}` : `Đã mở khoá tài khoản ${user.email}`);
  }

  return (
    <ConfirmDialog
      title={`${lock ? 'Khoá' : 'Mở khoá'} tài khoản ${user.email}`}
      confirmLabel={lock ? 'Khoá' : 'Mở khoá'}
      busy={isLoading || isSubmitting}
      onCancel={onCancel}
      onConfirm={() => void handleSubmit(onValid)()}
    >
      <p>
        {lock
          ? 'Tài khoản bị chặn ngay ở thao tác kế tiếp, không đăng nhập được cho tới khi mở khoá.'
          : 'Tài khoản đăng nhập và dùng lại được.'}
      </p>
      <Field label="Ghi chú (bắt buộc)" error={errors.note?.message}>
        {(a11y) => (
          <textarea {...a11y} {...register('note')} className="input" rows={3} maxLength={500} />
        )}
      </Field>
      <FieldError message={errors.root?.server?.message} />
    </ConfirmDialog>
  );
}
