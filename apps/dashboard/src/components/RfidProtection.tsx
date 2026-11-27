import type { RfidCreditProtection } from '@powerme/shared';

const reasons: Record<string, string> = {
  credit_cutoff: 'Chạm ngưỡng credit',
  insufficient_credit: 'Không đủ credit khi bắt đầu',
  unfunded_obligation: 'Nghĩa vụ chưa có ngân sách',
  tariff_unavailable: 'Chưa có biểu giá hợp lệ',
  meter_evidence_unavailable: 'Cần kiểm tra số đo',
};
const states: Record<string, string> = {
  pending: 'Chờ dừng',
  inflight: 'Đang gửi yêu cầu dừng',
  awaiting_stop: 'Trụ chấp nhận, chờ xác nhận dừng',
  retry: 'Chờ thử lại',
  exhausted: 'Đã hết lượt tự động dừng',
  completed: 'Đã nhận xác nhận dừng',
};
const errors: Record<string, string> = {
  conflicting_connector_sessions: 'Cần đối chiếu các phiên trên súng',
  awaiting_live_evidence: 'Chờ bằng chứng phiên còn chạy',
  remote_stop_rejected: 'Trụ từ chối dừng',
  outcome_unknown: 'Chưa rõ kết quả lệnh',
  stop_retry_exhausted: 'Cần kiểm tra và xử lý tại trụ',
};

export function RfidProtection({ data }: { data?: RfidCreditProtection }) {
  if (!data || data.total === 0) return null;
  return (
    <section aria-label="Bảo vệ credit RFID">
      <h2 className="section-title">Bảo vệ credit RFID</h2>
      <p>
        {data.total} phiên còn nghĩa vụ · {data.exhausted_stops} phiên hết lượt tự động dừng
      </p>
      <div className="card table-card">
        <div className="table-wrap">
          <table className="data-table" aria-label="Nghĩa vụ và lệnh dừng RFID">
            <thead>
              <tr>
                <th scope="col">Phiên</th>
                <th scope="col">Trụ / súng</th>
                <th scope="col">Credit đang giữ</th>
                <th scope="col">Bảo vệ credit</th>
                <th scope="col">Số lần gửi</th>
                <th scope="col">Lệnh cuối</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={row.session_id}>
                  <td>{row.session_id}</td>
                  <td>
                    {row.charge_point_id} / {row.connector_no}
                  </td>
                  <td>
                    {row.hold_state === 'released'
                      ? 'Đã nhả'
                      : row.held_vnd === null
                        ? 'Chưa xác định'
                        : BigInt(row.held_vnd).toLocaleString('vi-VN') + ' ₫'}
                  </td>
                  <td>
                    {row.stop_state && (
                      <span className={`pill ${row.stop_state === 'exhausted' ? 'critical' : ''}`}>
                        {states[row.stop_state] ?? 'Cần kiểm tra'}
                      </span>
                    )}
                    {row.stop_reason && <p>{reasons[row.stop_reason] ?? 'Cần kiểm tra credit'}</p>}
                    {row.last_error && (
                      <p className="muted small">
                        {errors[row.last_error] ?? 'Cần kiểm tra kết quả dừng'}
                      </p>
                    )}
                    {row.settlement_reason === 'account_closed' && (
                      <p>Tài khoản đã đóng, còn nghĩa vụ</p>
                    )}
                  </td>
                  <td>{row.attempts === null ? '—' : `${row.attempts} / ${row.attempt_limit}`}</td>
                  <td>{row.current_command_id ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data.total > data.items.length && (
        <p className="muted small">
          Hiển thị {data.items.length} / {data.total} phiên, ưu tiên phiên hết lượt tự động dừng.
        </p>
      )}
    </section>
  );
}
