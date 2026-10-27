/** Screen 28 — Users & Roles (UC-ADM-01/02): danh sách, lọc theo vai trò, đổi vai trò. */
import { useState } from 'react';
import { Card, Loading, PageHeader, Pill, Tabs } from '../../components/ui';
import { errorMessage, useSetUserRoleMutation, useUsersQuery } from '../../core/api/api';
import { useToast } from '../../hooks/toast';
import type { UserAccount } from '../../types/domain';
import { formatDateTime } from '../../utils/format';

type Filter = 'all' | UserAccount['role'];

export function UsersPage() {
  const toast = useToast();
  const { data, isLoading } = useUsersQuery();
  const [setRole] = useSetUserRoleMutation();
  const [filter, setFilter] = useState<Filter>('all');
  const rows = (data ?? []).filter((u) => filter === 'all' || u.role === filter);
  return (
    <>
      <PageHeader title="Người dùng & vai trò" subtitle="Tài khoản và quyền theo vai trò" />
      <Tabs
        tabs={[
          { id: 'all', label: 'Tất cả' },
          { id: 'driver', label: 'Tài xế' },
          { id: 'operator', label: 'Operator' },
          { id: 'admin', label: 'Admin' },
        ]}
        value={filter}
        onChange={setFilter}
      />
      {isLoading ? (
        <Loading />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tên</th>
                  <th>Email</th>
                  <th>Operator</th>
                  <th>Tạo lúc</th>
                  <th>Trạng thái</th>
                  <th>Vai trò</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td className="mono">{u.email}</td>
                    <td>{u.operatorName ?? '—'}</td>
                    <td>{formatDateTime(u.createdAt)}</td>
                    <td>
                      {u.status === 'active' ? (
                        <Pill tone="teal">Hoạt động</Pill>
                      ) : (
                        <Pill tone="muted">Đã đóng</Pill>
                      )}
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={`Vai trò của ${u.email}`}
                        value={u.role}
                        onChange={async (e) => {
                          const r = await setRole({
                            id: u.id,
                            role: e.target.value as UserAccount['role'],
                          });
                          if ('error' in r) toast.error(errorMessage(r.error));
                          else toast.success(`${u.email} → ${r.data.role}`);
                        }}
                      >
                        <option value="driver">Tài xế</option>
                        <option value="operator">Operator</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
