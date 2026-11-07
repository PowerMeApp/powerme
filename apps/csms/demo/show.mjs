/**
 * Truy vấn nhanh DB demo — không cần psql (máy dev không cài Postgres).
 *
 * Vì sao tồn tại: kịch bản trong docs/DEMO-REVIEW-2.md có cột "truy vấn kiểm chứng"; Hội đồng
 * hỏi "trong DB có gì?" thì chạy một lệnh là có bảng kết quả.
 *
 *   node demo/show.mjs                       # tóm tắt: phiên, bản ghi đối soát, epoch kết nối
 *   node demo/show.mjs "SELECT ... FROM ..."  # SQL tuỳ ý
 *
 * Kết nối: DATABASE_URL, mặc định DB demo ở 127.0.0.1:54330 (đổi cổng: DEMO_PG_PORT).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const url =
  process.env.DATABASE_URL ??
  `postgresql://powerme:powerme@127.0.0.1:${process.env.DEMO_PG_PORT ?? 54330}/powerme_demo`;

const SUMMARY = [
  [
    'Phiên sạc',
    `SELECT transaction_no AS tx, connector_no AS c, id_tag, origin, payment_mode, status,
            meter_start_wh AS start_wh, meter_stop_wh AS stop_wh, energy_wh, delivered_offline AS offline
     FROM sessions ORDER BY transaction_no`,
  ],
  [
    'Bản ghi đối soát',
    `SELECT s.transaction_no AS tx, r.record_no AS no, r.record_type, r.energy_difference_wh AS diff_wh,
            left(r.resolution, 70) AS resolution
     FROM reconciliation_records r JOIN sessions s ON s.id = r.session_id
     ORDER BY s.transaction_no, r.record_no`,
  ],
  [
    'Epoch kết nối',
    `SELECT cp.serial_number, cp.lifecycle, c.epoch, c.opened_at, c.closed_at, c.close_reason
     FROM charge_point_connections c JOIN charge_points cp ON cp.id = c.charge_point_id
     ORDER BY c.epoch`,
  ],
  [
    'Số dòng',
    `SELECT (SELECT count(*) FROM sessions) AS sessions,
            (SELECT count(*) FROM meter_values) AS meter_values,
            (SELECT count(*) FROM ocpp_message_log) AS ocpp_message_log,
            (SELECT count(*) FROM reconciliation_records) AS reconciliation_records`,
  ],
];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const queries = process.argv[2] ? [['Kết quả', process.argv[2]]] : SUMMARY;
  for (const [title, sql] of queries) {
    const { rows } = await client.query(sql);
    console.log(`\n== ${title} (${rows.length} dòng)`);
    if (rows.length) console.table(rows);
  }
} finally {
  await client.end();
}
