/**
 * Adapter PowerMe cho harness RQ1: chuẩn bị định danh (trụ, thẻ, tài xế) và đọc kết quả từ Postgres.
 *
 * Giao diện adapter (SteVe cài cùng giao diện, xem steve.mjs):
 *   endpoint                  URL gốc WebSocket cho trụ
 *   prepare(runs)             đăng ký mọi thứ lần chạy cần TRƯỚC khi trụ nối
 *   collect(run)              → { sessions: [...], extra: {...} } cho MỘT lần chạy
 *   close()
 * Mỗi phiên trả về đã chuẩn hoá: `outcome` = 'billed' | 'held' | 'open' và `eBillWh`.
 *
 * E_bill theo NFR-02 mục 2: `sessions.energy_wh` khi phiên `reconciled`; phiên `review` không có
 * E_bill. Cấu hình tắt đối soát đọc CÙNG cột (khi tắt, energy_wh = meterStop − meterStart).
 * Lưu ý G5: phiên bắt đầu bằng thẻ RFID chưa được quyết toán thật (không có dòng `session_debit`),
 * nên "đã tính tiền" ở đây nghĩa là "phiên đã `reconciled`, số Wh sẽ dùng để tính tiền đã chốt".
 * Cột `debit_vnd` ghi lại số tiền thật đã trừ nếu có, để thấy rõ điều này trong dữ liệu.
 */
const IDENT_RE = /^[A-Za-z0-9-]{1,40}$/;

/**
 * Trạm ẩn cho lần chạy trên CSMS dùng chung (staging, T130): thuộc operator `suspended` của dữ liệu
 * đo tải (lab/nfr03), nên tìm trạm / gợi ý dọc đường / bắt đầu sạc từ app đều không thấy; đường OCPP
 * không xét trạng thái operator nên trụ vẫn nối và sạc bằng thẻ được.
 */
export const HIDDEN_OPERATOR_TAX_CODE = 'LOADTEST01';
export const HIDDEN_SITE_CODE = 'RQ1-LAB-01';

export function powermeOutcome(session) {
  if (session.status === 'review') return 'held';
  if (session.status === 'reconciled' && session.energy_wh !== null) return 'billed';
  return 'open';
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * @param opts.db        đối tượng có `query(sql, params)` kiểu pg.Client
 * @param opts.endpoint  ws://host:port/ocpp
 */
export function createPowermeAdapter({
  db,
  endpoint,
  name = 'powerme',
  siteCode = 'HCM-DEMO-01',
  hashPassword = null,
}) {
  return {
    name,
    endpoint,

    /** Mỗi lần chạy một trụ + một tài xế + một thẻ riêng → các lần chạy song song không đụng nhau. */
    async prepare(runs) {
      for (const run of runs) {
        if (!IDENT_RE.test(run.chargePoint) || !IDENT_RE.test(run.idTag)) {
          throw new Error(`định danh không hợp lệ: ${run.chargePoint} / ${run.idTag}`);
        }
      }
      if (siteCode === HIDDEN_SITE_CODE) {
        await db.query(
          `INSERT INTO operators (tax_code, legal_name, address, status)
           VALUES ($1, 'LOAD-TEST NFR-03 (khong phai don vi that)', 'Du lieu do tai, an khoi app', 'suspended')
           ON CONFLICT ON CONSTRAINT operators_tax_code_key DO NOTHING`,
          [HIDDEN_OPERATOR_TAX_CODE],
        );
        await db.query(
          `INSERT INTO sites (site_code, operator_id, site_name, address, latitude, longitude)
           SELECT $2, o.id, 'RQ1-LAB (thi nghiem doi soat)', 'Du lieu thi nghiem (Point Nemo)',
                  -48.876667, -123.393333
           FROM operators o WHERE o.tax_code = $1
           ON CONFLICT ON CONSTRAINT sites_site_code_key DO NOTHING`,
          [HIDDEN_OPERATOR_TAX_CODE, HIDDEN_SITE_CODE],
        );
      }
      const site = await db.query('SELECT s.id FROM sites s WHERE s.site_code = $1 LIMIT 1', [
        siteCode,
      ]);
      if (!site.rows[0]) throw new Error(`thiếu site ${siteCode} — chưa nạp demo/seed.sql?`);
      const siteId = site.rows[0].id;
      // CSMS bật kiểm credential (staging): mỗi trụ một salt riêng, băm TRƯỚC transaction.
      const hashes = [];
      if (hashPassword) for (let i = 0; i < runs.length; i++) hashes.push(await hashPassword());
      await db.query('BEGIN');
      try {
        for (const [i, run] of runs.entries()) {
          const email = `${run.idTag.toLowerCase()}@rq1.powerme.test`;
          const ref = `RQ1-${run.idTag}`;
          await db.query(
            `INSERT INTO charge_points (serial_number, display_code, site_id, model, firmware_version,
               rated_power_kw, lifecycle, reports_soc, supports_reservation)
             VALUES ($1, $2, $3, 'D1-120', 'rq1-lab', 120, 'awaiting_connection', false, false)
             ON CONFLICT ON CONSTRAINT charge_points_serial_number_key DO NOTHING`,
            [run.chargePoint, `PM-${run.chargePoint}`, siteId],
          );
          if (hashPassword) {
            // Chỉ đụng trụ của chính trạm thí nghiệm (không ghi đè credential trụ khác trùng serial).
            const set = await db.query(
              `UPDATE charge_points SET basic_auth_password_hash = $2, updated_at = now()
               WHERE serial_number = $1 AND site_id = $3`,
              [run.chargePoint, hashes[i], siteId],
            );
            if (set.rowCount !== 1)
              throw new Error(`trụ ${run.chargePoint} đã tồn tại ở trạm khác — đổi --batch`);
          }
          await db.query(
            `INSERT INTO connectors (charge_point_id, connector_no, connector_type, max_power_kw)
             SELECT cp.id, n.no, 'ccs2', 60 FROM charge_points cp CROSS JOIN (VALUES (1), (2)) AS n(no)
             WHERE cp.serial_number = $1
             ON CONFLICT ON CONSTRAINT connectors_charge_point_id_connector_no_key DO NOTHING`,
            [run.chargePoint],
          );
          const user = await db.query(
            `INSERT INTO users (email, full_name, role, account_status)
             VALUES ($1, $2, 'driver', 'active')
             ON CONFLICT ON CONSTRAINT users_email_key DO UPDATE SET email = EXCLUDED.email
             RETURNING id`,
            [email, `RQ1 Driver ${i + 1}`],
          );
          const userId = user.rows[0].id;
          await db.query(
            `INSERT INTO drivers (user_id, consent_version, consent_given_at)
             VALUES ($1, '2026-09', now()) ON CONFLICT (user_id) DO NOTHING`,
            [userId],
          );
          await db.query(
            `INSERT INTO credit_accounts (driver_id, status, balance_vnd)
             VALUES ($1, 'active', 500000)
             ON CONFLICT ON CONSTRAINT credit_accounts_driver_id_key DO NOTHING`,
            [userId],
          );
          await db.query(
            `INSERT INTO top_ups (gateway_reference, credit_account_id, amount_vnd, points_discount_vnd,
               amount_paid_vnd, status, idempotency_key, expires_at, completed_at)
             SELECT $2, ca.id, 500000, 0, 500000, 'credited', $3, now() + interval '15 minutes', now()
             FROM credit_accounts ca WHERE ca.driver_id = $1
             ON CONFLICT DO NOTHING`,
            [userId, ref, `rq1-topup-${run.idTag}`],
          );
          await db.query(
            `INSERT INTO credit_transactions (credit_account_id, entry_no, transaction_type, amount_vnd,
               balance_after_vnd, top_up_id)
             SELECT t.credit_account_id, 1, 'top_up', 500000, 500000, t.id
             FROM top_ups t WHERE t.idempotency_key = $1
             ON CONFLICT ON CONSTRAINT credit_transactions_account_entry_no_key DO NOTHING`,
            [`rq1-topup-${run.idTag}`],
          );
          await db.query(
            `INSERT INTO rfid_cards (card_identifier, card_kind, driver_id, status)
             VALUES ($1, 'online', $2, 'active')
             ON CONFLICT ON CONSTRAINT rfid_cards_card_identifier_key DO NOTHING`,
            [run.idTag, userId],
          );
        }
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      }
    },

    async collect(run) {
      const { rows } = await db.query(
        `SELECT s.id, s.transaction_no, s.status, s.origin, s.payment_mode, s.meter_start_wh,
                s.meter_stop_wh, s.energy_wh, s.delivered_offline, s.stop_reason
         FROM sessions s JOIN charge_points cp ON cp.id = s.charge_point_id
         WHERE cp.serial_number = $1 ORDER BY s.id`,
        [run.chargePoint],
      );
      const sessions = [];
      for (const s of rows) {
        const rec = await db.query(
          `SELECT record_type::text AS t, count(*)::int AS n FROM reconciliation_records
           WHERE session_id = $1 GROUP BY 1`,
          [s.id],
        );
        const records = Object.fromEntries(rec.rows.map((r) => [r.t, r.n]));
        // T132: khe hở "còn mở" = bản ghi kết luận gap_detected chưa có bản ghi gap_closed trỏ tới.
        // `gap_closed` / `open_gap` không phải record_type của CSMS, chỉ là hai số đếm của harness.
        const gaps = await db.query(
          `SELECT count(*) FILTER (WHERE r.resolution LIKE 'gap_closed%')::int AS closed,
                  count(*) FILTER (
                    WHERE r.resolution LIKE 'gap_detected%' AND NOT EXISTS (
                      SELECT 1 FROM reconciliation_records c
                      WHERE c.session_id = r.session_id AND c.resolution LIKE 'gap_closed%'
                        AND c.resolution ~ ('(^|\\s)closes_record_no=' || r.record_no || '(\\s|$)')
                    )
                  )::int AS open
           FROM reconciliation_records r WHERE r.session_id = $1`,
          [s.id],
        );
        records.gap_closed = gaps.rows[0].closed;
        records.open_gap = gaps.rows[0].open;
        const debit = await db.query(
          `SELECT coalesce(sum(amount_vnd), 0)::bigint AS vnd, count(*)::int AS n
           FROM credit_transactions WHERE session_id = $1 AND transaction_type = 'session_debit'`,
          [s.id],
        );
        const hist = await db.query(
          `SELECT string_agg(coalesce(from_status::text, '-') || '>' || to_status::text || ':' || event,
                             ' ' ORDER BY id) AS path
           FROM session_status_history WHERE session_id = $1`,
          [s.id],
        );
        const outcome = powermeOutcome(s);
        sessions.push({
          sessionId: String(s.id),
          transactionId: Number(s.transaction_no),
          status: s.status,
          outcome,
          eBillWh: outcome === 'billed' ? num(s.energy_wh) : null,
          meterStartWh: num(s.meter_start_wh),
          meterStopWh: num(s.meter_stop_wh),
          paymentMode: s.payment_mode,
          deliveredOffline: s.delivered_offline,
          records,
          debitVnd: debit.rows[0].n > 0 ? Number(debit.rows[0].vnd) : null,
          statusPath: hist.rows[0]?.path ?? null,
        });
      }
      return { sessions, extra: {} };
    },

    /** Phiên của lần chạy đã tới trạng thái cuối chưa (để bộ chạy biết lúc nào thôi chờ). */
    isSettled(result) {
      return (
        result.sessions.length > 0 &&
        result.sessions.every((s) => s.status === 'reconciled' || s.status === 'review')
      );
    },

    /**
     * Cất trụ thí nghiệm trên CSMS dùng chung sau khi chạy (không xoá: nhật ký OCPP và lịch sử phiên
     * là append-only): gỡ credential, `in_service → disabled` (để OfflineAlertService không mở sự cố
     * Offline sau 900 s), khoá thẻ, `suspended` tài khoản tài xế của lô.
     */
    async park(runs) {
      const serials = runs.map((r) => r.chargePoint);
      const idTags = runs.map((r) => r.idTag);
      const emails = idTags.map((t) => `${t.toLowerCase()}@rq1.powerme.test`);
      await db.query('BEGIN');
      try {
        const cps = await db.query(
          `UPDATE charge_points cp
              SET basic_auth_password_hash = NULL,
                  lifecycle = CASE WHEN cp.lifecycle = 'in_service'
                                   THEN 'disabled'::charge_point_lifecycle ELSE cp.lifecycle END,
                  updated_at = now()
             FROM sites s
            WHERE s.id = cp.site_id AND s.site_code = $1 AND cp.serial_number = ANY($2::text[])`,
          [siteCode, serials],
        );
        const cards = await db.query(
          `UPDATE rfid_cards SET status = 'blocked'
            WHERE card_identifier = ANY($1::text[]) AND status <> 'blocked'`,
          [idTags],
        );
        const drivers = await db.query(
          `UPDATE users SET account_status = 'suspended', updated_at = now()
            WHERE email = ANY($1::text[]) AND role = 'driver' AND account_status = 'active'`,
          [emails],
        );
        await db.query('COMMIT');
        return { chargePoints: cps.rowCount, cards: cards.rowCount, drivers: drivers.rowCount };
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
      }
    },

    async close() {},
  };
}
