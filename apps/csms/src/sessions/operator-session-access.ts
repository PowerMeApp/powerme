/**
 * Kiểm quyền operator trên một phiên — dùng chung cho SessionReviewService (BE-18, STM-1 #17) và
 * UnattributedSessionService (BE-24, F-12), để hai đường xử lý phiên của operator không lệch nhau.
 *
 * Người gọi phải là `operator_staff` đang hoạt động (users.role + account_status) của một operator
 * đang hoạt động, và phiên phải nằm trên trụ thuộc site của CHÍNH operator đó (BR-P11/P16; migration
 * 0012: reconciliation_records.reviewed_by trỏ operator_staff). Phiên của operator khác trả
 * `not_found` như phiên không tồn tại — không lộ dữ liệu liên-operator.
 *
 * Phải gọi trong transaction: dòng `sessions` bị khoá `FOR UPDATE` tới khi commit, nên hai quyết
 * định đồng thời trên cùng một phiên chạy nối tiếp.
 */
import type { PoolClient } from 'pg';

export interface OperatorSessionRow {
  status: string;
  received_stopped_at: Date | null;
  payment_mode: string;
  origin: string;
  driver_id: string | null;
  rfid_card_id: string | null;
}

export type OperatorSessionLock =
  | { ok: true; operatorId: string; session: OperatorSessionRow }
  | { ok: false; code: 'forbidden' | 'not_found' };

export async function lockOperatorSession(
  c: PoolClient,
  sessionId: number,
  operatorUserId: number,
): Promise<OperatorSessionLock> {
  const staff = (
    await c.query<{ operator_id: string }>(
      `SELECT staff.operator_id FROM users u
       JOIN operator_staff staff ON staff.user_id=u.id
       JOIN operators o ON o.id=staff.operator_id AND o.status='active'
       WHERE u.id=$1 AND u.role='operator_staff' AND u.account_status='active'`,
      [operatorUserId],
    )
  ).rows[0];
  if (!staff) return { ok: false, code: 'forbidden' };
  const session = (
    await c.query<OperatorSessionRow>(
      `SELECT s.status,s.received_stopped_at,s.payment_mode,s.origin,s.driver_id,s.rfid_card_id
       FROM sessions s
       JOIN charge_points cp ON cp.id=s.charge_point_id JOIN sites st ON st.id=cp.site_id
       WHERE s.id=$1 AND st.operator_id=$2 FOR UPDATE OF s`,
      [sessionId, staff.operator_id],
    )
  ).rows[0];
  if (!session) return { ok: false, code: 'not_found' };
  return { ok: true, operatorId: staff.operator_id, session };
}
