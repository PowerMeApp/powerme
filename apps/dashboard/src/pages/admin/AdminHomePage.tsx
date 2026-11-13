/** Screen 27 — Admin Dashboard (hub). Platform counts arrive with FE-14 (D36: no placeholder numbers). */
import { errorMessage, useAdminMeQuery } from '../../core/api/api';

export function AdminHomePage() {
  const { data, error, isLoading } = useAdminMeQuery();
  return (
    <>
      <div className="page-head">
        <h1>Tổng quan nền tảng</h1>
      </div>
      <div className="card">
        {isLoading && <p className="muted">Đang tải…</p>}
        {error && <p role="alert">{errorMessage(error)}</p>}
        {data && <p>Xin chào {data.full_name}. Bạn đang quản trị toàn nền tảng PowerMe.</p>}
      </div>
    </>
  );
}
