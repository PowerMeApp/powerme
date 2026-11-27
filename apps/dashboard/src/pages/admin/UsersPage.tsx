/**
 * Screen 28 — Users & Roles (FE-19, UC-ADM-01/02, BR-P05, BR-P16, F-13), Admin only. Every account
 * of the platform (GET /api/admin/v1/users) with role, Operator and status; filters by role, status,
 * Operator and a search (name / email contains, or phone). "Tạo tài khoản" creates operator staff or
 * an admin (drivers sign up themselves). Per row: Sửa, Đổi vai trò (not for drivers), Khoá / Mở
 * khoá with a note. The signed-in Admin cannot change their own role or lock themselves. No delete.
 */
import { Button, Group, Loader, Table } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import type { UserAccount } from '@powerme/shared';
import { useAdminOperatorsQuery, useAdminUsersQuery, USER_PAGE_SIZE } from '../../core/api/api';
import { useAppSelector } from '../../core/store/store';
import { useDebounced } from '../../core/search/search';
import { ROLE, STAFF_ROLE, STATUS, userError } from '../../features/users/format';
import {
  CreateUserDialog,
  EditUserDialog,
  LockDialog,
  RoleDialog,
} from '../../features/users/UserDialogs';
import { DataTable, EmptyState } from '../../ui/DataTable';
import { FilterBar, SearchInput, SelectFilter } from '../../ui/FilterBar';
import { Notice, type Note } from '../../ui/Notice';
import { PageHeader } from '../../ui/PageHeader';
import { Pager, pageCount } from '../../ui/Pager';
import { StatusBadge } from '../../ui/StatusBadge';

type Dialog = { kind: 'create' } | { kind: 'edit' | 'role' | 'lock'; user: UserAccount };

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
    <Table.Tr
      aria-label={`Tài khoản ${u.email}`}
      data-tone={u.account_status === 'suspended' ? 'major' : undefined}
    >
      <Table.Td>
        <span className="cell-title">{u.full_name}</span>
        {self && (
          <>
            {' '}
            <StatusBadge tone="muted" size="sm">
              Bạn
            </StatusBadge>
          </>
        )}
      </Table.Td>
      <Table.Td>
        {u.email}
        {u.phone_number && <div className="muted small">{u.phone_number}</div>}
      </Table.Td>
      <Table.Td>
        {ROLE[u.role]}
        {u.role === 'operator_staff' && (
          <div className="muted small">
            {u.staff_role ? STAFF_ROLE[u.staff_role] : ''}
            {u.operator ? ` · ${u.operator.legal_name}` : ''}
          </div>
        )}
      </Table.Td>
      <Table.Td>
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </Table.Td>
      <Table.Td className="nowrap">{day(u.created_at)}</Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <Button type="button" size="compact-sm" variant="light" onClick={() => onAction('edit')}>
            Sửa
          </Button>
          {u.role !== 'driver' && !self && (
            <Button
              type="button"
              size="compact-sm"
              variant="default"
              onClick={() => onAction('role')}
            >
              Đổi vai trò
            </Button>
          )}
          {!self && u.account_status !== 'closed' && (
            <Button
              type="button"
              size="compact-sm"
              variant="default"
              onClick={() => onAction('lock')}
            >
              {u.account_status === 'active' ? 'Khoá' : 'Mở khoá'}
            </Button>
          )}
        </Group>
      </Table.Td>
    </Table.Tr>
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
  const pages = pageCount(total, USER_PAGE_SIZE);
  if (data && page > pages) setPage(pages);
  const filtered = !!(role || status || operatorId || query);
  const done = (text: string) => {
    setDialog(null);
    setNote({ tone: 'ok', text });
  };

  const first = ((data?.page ?? 1) - 1) * (data?.page_size ?? USER_PAGE_SIZE) + 1;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Tài khoản & vai trò' }]}
        title="Tài khoản & vai trò"
        actions={
          <Button
            leftSection={<IconPlus size={16} aria-hidden="true" />}
            onClick={() => {
              setNote(null);
              setDialog({ kind: 'create' });
            }}
          >
            Tạo tài khoản
          </Button>
        }
      />
      <FilterBar>
        <SearchInput
          label="Tìm tài khoản"
          value={search}
          placeholder="Tên, email hoặc số điện thoại"
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
        />
        <SelectFilter
          label="Vai trò"
          value={role}
          options={[
            ['', 'Tất cả'],
            ...(Object.keys(ROLE) as UserAccount['role'][]).map((r) => [r, ROLE[r]] as const),
          ]}
          onChange={(v) => {
            setRole(v);
            setPage(1);
          }}
        />
        <SelectFilter
          label="Trạng thái"
          value={status}
          options={[
            ['', 'Tất cả'],
            ...(Object.keys(STATUS) as UserAccount['account_status'][]).map(
              (k) => [k, STATUS[k][0]] as const,
            ),
          ]}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
        <SelectFilter
          label="Đơn vị vận hành"
          value={operatorId}
          options={[['', 'Tất cả'], ...operatorList.map((o) => [o.id, o.legal_name] as const)]}
          onChange={(v) => {
            setOperatorId(v);
            setPage(1);
          }}
        />
      </FilterBar>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}
      {isLoading ? (
        <Loader size="sm" aria-label="Đang tải…" />
      ) : error && !data ? (
        <Notice tone="error">{userError(error)}</Notice>
      ) : !data || data.items.length === 0 ? (
        <EmptyState>
          {filtered ? 'Không có tài khoản nào khớp bộ lọc.' : 'Chưa có tài khoản nào.'}
        </EmptyState>
      ) : (
        <DataTable
          minWidth={900}
          footer={
            <Pager
              first={first}
              last={first + data.items.length - 1}
              total={total}
              page={page}
              pages={pages}
              onPage={setPage}
            />
          }
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Họ tên</Table.Th>
              <Table.Th scope="col">Email · điện thoại</Table.Th>
              <Table.Th scope="col">Vai trò</Table.Th>
              <Table.Th scope="col">Trạng thái</Table.Th>
              <Table.Th scope="col">Ngày tạo</Table.Th>
              <Table.Th scope="col">Thao tác</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
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
          </Table.Tbody>
        </DataTable>
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
