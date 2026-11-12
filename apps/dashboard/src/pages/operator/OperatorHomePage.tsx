/**
 * Screen 17 — Operator Dashboard (hub). Charge point counts and open alerts arrive with FE-03 / FE-04;
 * until then no numbers are shown (D36). Loading /me also checks a restored session on reload.
 */
import { errorMessage, useOperatorMeQuery } from '../../core/api/api';

export function OperatorHomePage() {
  const { data, error, isLoading } = useOperatorMeQuery();
  return (
    <>
      <div className="page-head">
        <h1>Tổng quan vận hành</h1>
        {data && <p>{data.operator_name}</p>}
      </div>
      <div className="card">
        {isLoading && <p className="muted">Đang tải…</p>}
        {error && <p role="alert">{errorMessage(error)}</p>}
        {data && (
          <p>
            Xin chào {data.full_name}. Bạn đang xem dữ liệu của Operator <b>{data.operator_name}</b>
            .
          </p>
        )}
      </div>
    </>
  );
}
