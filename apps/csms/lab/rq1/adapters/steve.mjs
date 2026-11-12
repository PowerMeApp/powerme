/**
 * Adapter SteVe cho harness RQ1 — cấu hình đối chứng thứ ba (CSMS mã nguồn mở, Java + MariaDB).
 *
 * TRẠNG THÁI: CHƯA CHẠY VỚI SteVe THẬT (máy dev không có Docker). Tên bảng/cột dưới đây đối chiếu
 * với MÃ NGUỒN SteVe tag `steve-3.14.1` (đọc trên GitHub ngày 12/11/2026):
 *   - migration `V1_1_4__update.sql`: bảng `connector` đổi tên thành `evse` (`evse_pk`,
 *     `charge_box_id`, `evse_id`), `transaction_start.connector_pk` → `evse_pk`,
 *     `connector_meter_value.connector_pk` → `evse_pk`; view `transaction` dựng lại trên `evse_pk`.
 *   - `OcppServerRepositoryImpl.insertIgnoreTransaction`: StartTransaction trùng (evse, id_tag,
 *     start_timestamp, start_value) trả lại `transaction_pk` cũ.
 *   - `updateTransaction`: mỗi StopTransaction là một dòng `transaction_stop` (PK = transaction_pk +
 *     event_timestamp); view `transaction` lấy dòng có `event_timestamp` lớn nhất. Lỗi khi ghi thì
 *     vào `transaction_stop_failed`.
 * Bản SteVe CŨ hơn V1_1_4 dùng `connector`/`connector_pk`: đặt `schema: 'connector'`.
 *
 * E_bill theo NFR-02 mục 2: `stop_value − start_value` (SteVe không có khái niệm giữ phiên lại,
 * nên giao dịch đã có stop coi như "đã tính tiền"; chưa có stop → `open`).
 *
 * Adapter chỉ cần một hàm `query(sql) → Promise<object[]>` nên test được bằng dữ liệu giả
 * (steve.spec.mjs). Hàm thật: `dockerMariadbQuery` chạy client `mariadb` trong container qua
 * `docker compose exec` — không thêm driver MySQL vào repo.
 */
import { spawn } from 'node:child_process';

const IDENT_RE = /^[A-Za-z0-9-]{1,40}$/;

function assertIdent(value) {
  if (!IDENT_RE.test(value)) throw new Error(`định danh không hợp lệ cho SteVe: ${value}`);
  return value;
}

/** Số nguyên Wh từ cột varchar của SteVe (`start_value`, `stop_value`); không phải số → null. */
export function parseWh(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Tên bảng/cột theo phiên bản schema. */
const SCHEMAS = {
  evse: { table: 'evse', pk: 'evse_pk' },
  connector: { table: 'connector', pk: 'connector_pk' },
};

/** SQL đăng ký trụ và thẻ (idempotent). Trả mảng câu lệnh — cũng dùng cho `--print-sql`. */
export function registrationSql(runs) {
  const boxes = runs.map((r) => `('${assertIdent(r.chargePoint)}', 'Accepted')`).join(', ');
  const tags = runs.map((r) => `('${assertIdent(r.idTag)}', 1)`).join(', ');
  return [
    `INSERT IGNORE INTO charge_box (charge_box_id, registration_status) VALUES ${boxes}`,
    // max_active_transaction_count = 1: thẻ hợp lệ, tối đa một giao dịch đang mở (0 = bị chặn).
    `INSERT IGNORE INTO ocpp_tag (id_tag, max_active_transaction_count) VALUES ${tags}`,
  ];
}

/**
 * @param opts.query     (sql) → Promise<object[]>; giá trị NULL là null, còn lại là chuỗi hoặc số
 * @param opts.endpoint  ws://host:port/steve/websocket/CentralSystemService
 * @param opts.schema    'evse' (SteVe ≥ migration V1_1_4, mặc định) | 'connector' (bản cũ)
 */
export function createSteveAdapter({ query, endpoint, schema = 'evse', name = 'steve' }) {
  const sc = SCHEMAS[schema];
  if (!sc) throw new Error(`schema SteVe lạ: ${schema}`);
  return {
    name,
    endpoint,

    async prepare(runs) {
      for (const sql of registrationSql(runs)) await query(sql);
    },

    async collect(run) {
      const box = assertIdent(run.chargePoint);
      const rows = await query(
        `SELECT t.transaction_pk, t.id_tag, t.start_value, t.stop_value, t.start_timestamp,
                t.stop_timestamp, t.stop_reason,
                (SELECT COUNT(*) FROM transaction_stop s WHERE s.transaction_pk = t.transaction_pk)
                  AS stop_rows,
                (SELECT COUNT(*) FROM connector_meter_value m
                  WHERE m.transaction_pk = t.transaction_pk
                    AND m.measurand = 'Energy.Active.Import.Register') AS energy_samples
         FROM \`transaction\` t JOIN ${sc.table} e ON e.${sc.pk} = t.${sc.pk}
         WHERE e.charge_box_id = '${box}' ORDER BY t.transaction_pk`,
      );
      const failed = await query(
        `SELECT COUNT(*) AS n FROM transaction_stop_failed WHERE charge_box_id = '${box}'`,
      );
      const sessions = rows.map((t) => {
        const start = parseWh(t.start_value);
        const stop = parseWh(t.stop_value);
        const stopped = stop !== null && start !== null;
        return {
          sessionId: String(t.transaction_pk),
          transactionId: Number(t.transaction_pk),
          status: stopped ? 'stopped' : 'active',
          outcome: stopped ? 'billed' : 'open',
          eBillWh: stopped ? stop - start : null,
          meterStartWh: start,
          meterStopWh: stop,
          paymentMode: null,
          deliveredOffline: null,
          // SteVe không có bản ghi đối soát; số dòng stop > 1 là dấu vết StopTransaction gửi lại.
          records: Number(t.stop_rows) > 1 ? { duplicate_stop_rows: Number(t.stop_rows) - 1 } : {},
          debitVnd: null,
          statusPath: null,
          energySamples: Number(t.energy_samples),
        };
      });
      return { sessions, extra: { stopFailedRows: Number(failed[0]?.n ?? 0) } };
    },

    isSettled(result) {
      return result.sessions.length > 0 && result.sessions.every((s) => s.status === 'stopped');
    },

    async close() {},
  };
}

/** Đọc đầu ra `mariadb --batch --raw` (dòng đầu là tên cột, cách nhau bằng tab; NULL in ra "NULL"). */
export function parseBatchOutput(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] === 'NULL' ? null : cells[i]]));
  });
}

/**
 * Hàm `query` thật: chạy client `mariadb` TRONG container DB của SteVe, SQL đưa qua stdin.
 * Mật khẩu lấy từ biến môi trường sẵn có của container (MYSQL_USER / MYSQL_PASSWORD /
 * MYSQL_DATABASE do image mariadb đặt), nên không đi qua dòng lệnh hay repo.
 */
export function dockerMariadbQuery({ composeFile, service = 'mariadb', docker = 'docker' }) {
  const args = [
    'compose',
    '-f',
    composeFile,
    'exec',
    '-T',
    service,
    'sh',
    '-c',
    'exec mariadb --batch --raw -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"',
  ];
  return (sql) =>
    new Promise((resolve, reject) => {
      const child = spawn(docker, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8').on('data', (c) => (out += c));
      child.stderr.setEncoding('utf8').on('data', (c) => (err += c));
      child.on('error', (e) => reject(new Error(`không chạy được ${docker}: ${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`mariadb thoát mã ${code}: ${err.trim().slice(0, 500)}`));
        else resolve(parseBatchOutput(out));
      });
      child.stdin.end(`${sql};\n`);
    });
}
