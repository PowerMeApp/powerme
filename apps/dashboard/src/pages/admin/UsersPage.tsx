/**
 * Screen 28 — Users & Roles (FE-19, UC-ADM-01/02, BR-P05, BR-P16, F-13), Admin only. Every account
 * of the platform (GET /api/admin/v1/users) with role, Operator and status; filters by role, status,
 * Operator and a search (name / email contains, or phone). "Tạo tài khoản" creates operator staff or
 * an admin (drivers sign up themselves). Per row: Sửa, Đổi vai trò (not for drivers), Khoá / Mở
 * khoá with a note. The signed-in Admin cannot change their own role or lock themselves. No delete.
 */
import { useState } from 'react';
import type { UserAccount } from '@powerme/shared';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { useAdminOperatorsQuery, useAdminUsersQuery, USER_PAGE_SIZE } from '../../core/api/api';
import { useAppSelector } from '../../core/store/store';
import { MAX_SEARCH, useDebounced } from '../../core/search/search';
import { ROLE, STAFF_ROLE, STATUS, userError } from '../../features/users/format';
import {
  CreateUserDialog,
  EditUserDialog,
  LockDialog,
  RoleDialog,
} from '../../features/users/UserDialogs';

type Dialog = { kind: 'create' } | { kind: 'edit' | 'role' | 'lock'; user: UserAccount };
type Note = { tone: 'ok' | 'error'; text: string } | null;

const day = (iso: string) => new Date(iso).toLocaleDateString('vi-VN');

function Row({
  u,
  self,
  onAction,
}: {
  u: UserAccount;
  self: boolean;
  onAction: (kind: 'edit' | 'role' | 'lock') => void;
}) {
  const [label, tone] = STATUS[u.account_status];
  return (
    <tr aria-label={`Tài khoản ${u.email}`}>
      <td>
        <span className="cell-title">{u.full_name}</span>
        {self && <span className="pill muted"> Bạn</span>}
      </td>
      <td>
        {u.email}
        {u.phone_number && <div className="muted small">{u.phone_number}</div>}
      </td>
      <td>
        {ROLE[u.role]}
        {u.role === 'operator_staff' && (
          <div className="muted small">
            {u.staff_role ? STAFF_ROLE[u.staff_role] : ''}
            {u.operator ? ` · ${u.operator.legal_name}` : ''}
          </div>
        )}
      </td>
      <td>
        <span className={`pill ${tone}`}>{label}</span>
      </td>
      <td className="nowrap">{day(u.created_at)}</td>
      <td>
        <div className="btn-row">
          <button type="button" className="btn small" onClick={() => onAction('edit')}>
            Sửa
          </button>
          {u.role !== 'driver' && !self && (
            <button type="button" className="btn small ghost" onClick={() => onAction('role')}>
              Đổi vai trò
            </button>
          )}
          {!self && u.account_status !== 'closed' && (
            <button type="button" className="btn small ghost" onClick={() => onAction('lock')}>
              {u.account_status === 'active' ? 'Khoá' : 'Mở khoá'}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export function UsersPage() {
  const selfId = useAppSelector((s) => s.auth.user?.user_id);
  const [role, setRole] = useState<UserAccount['role'] | ''>('');
  const [status, setStatus] = useState<UserAccount['account_status'] | ''>('');
  const [operatorId, setOperatorId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [note, setNote] = useState<Note>(null);
  const q = useDebounced(search);
  const operators = useAdminOperatorsQuery();
  const operatorList = operators.data?.items ?? [];
  // `q` needs 2+ characters on the server; shorter text is not sent.
  const query = q.trim().length >= 2 ? q : '';
  const { data, error, isLoading, refetch } = useAdminUsersQuery({
    page,
    ...(role ? { role } : {}),
    ...(status ? { account_status: status } : {}),
    ...(operatorId ? { operator_id: operatorId } : {}),
    ...(query ? { q: query } : {}),
  });
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / USER_PAGE_SIZE));
  if (data && page > pages) setPage(pages);
  const filtered = !!(role || status || operatorId || query);
  const done = (text: string) => {
    setDialog(null);
    setNote({ tone: 'ok', text });
  };

  return (
    <>
      <Breadcrumbs items={[{ label: 'Tài khoản & vai trò' }]} />
      <div className="page-head">
        <h1>Tài khoản &amp; vai trò</h1>
        <button
          type="button"
          className="btn primary page-action"
          onClick={() => {
            setNote(null);
            setDialog({ kind: 'create' });
          }}
        >
          Tạo tài khoản
        </button>
      </div>
      <div className="filters">
        <label className="field search-field">
          Tìm tài khoản
          <input
            className="input"
            type="search"
            value={search}
            maxLength={MAX_SEARCH}
            placeholder="Tên, thư điện tử hoặc số điện thoại"
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="field">
          Vai trò
          <select
            className="input"
            value={role}
            onChange={(e) => {
              setRole(e.target.value as UserAccount['role'] | '');
              setPage(1);
            }}
          >
            <option value="">Tất cả</option>
            {(Object.keys(ROLE) as UserAccount['role'][]).map((r) => (
              <option key={r} value={r}>
                {ROLE[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Trạng thái
          <select
            className="input"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as UserAccount['account_status'] | '');
              setPage(1);
            }}
          >
            <option value="">Tất cả</option>
            {(Object.keys(STATUS) as UserAccount['account_status'][]).map((s) => (
              <option key={s} value={s}>
                {STATUS[s][0]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Đơn vị vận hành
          <select
            className="input"
            value={operatorId}
            onChange={(e) => {
              setOperatorId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Tất cả</option>
            {operatorList.map((o) => (
              <option key={o.id} value={o.id}>
                {o.legal_name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {note && (
        <p className={`queue-note ${note.tone}`} role={note.tone === 'ok' ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      {isLoading ? (
        <p className="muted">Đang tải…</p>
      ) : error && !data ? (
        <p role="alert">{userError(error)}</p>
      ) : !data || data.items.length === 0 ? (
        <div className="card">
          <p className="muted">
            {filtered ? 'Không có tài khoản nào khớp bộ lọc.' : 'Chưa có tài khoản nào.'}
          </p>
        </div>
      ) : (
        <div className="card table-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Họ tên</th>
                  <th scope="col">Thư điện tử · điện thoại</th>
                  <th scope="col">Vai trò</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Ngày tạo</th>
                  <th scope="col">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((u) => (
                  <Row
                    key={u.id}
                    u={u}
                    self={u.id === selfId}
                    onAction={(kind) => {
                      setNote(null);
                      setDialog({ kind, user: u });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Phân trang">
            <span className="muted">
              {total} tài khoản · Trang {page} / {pages}
            </span>
            <div className="btn-row">
              <button
                type="button"
                className="btn small ghost"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                ‹ Trước
              </button>
              <button
                type="button"
                className="btn small ghost"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                Sau ›
              </button>
            </div>
          </nav>
        </div>
      )}
      {dialog?.kind === 'create' && (
        <CreateUserDialog operators={operatorList} onDone={done} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'edit' && (
        <EditUserDialog user={dialog.user} onDone={done} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'role' && (
        <RoleDialog
          user={dialog.user}
          operators={operatorList}
          onDone={done}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'lock' && (
        <LockDialog
          user={dialog.user}
          onDone={done}
          onCancel={() => setDialog(null)}
          onStale={() => void refetch()}
        />
      )}
    </>
  );
}
