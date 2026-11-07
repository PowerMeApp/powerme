// Ghi frame OCPP thô ra JSONL — tách từ mini-csms.mjs để dùng chung.
//
// mini-csms.mjs CỐ Ý không import file này: nó được giữ nguyên si để EXP-01
// còn tái lập được đúng như lúc chạy. Dụng cụ đo mà sửa giữa chừng thì số liệu
// trước và sau không so được với nhau nữa.

import { createWriteStream, mkdirSync } from 'node:fs';

export const now = () => new Date().toISOString();

// Timestamp do TRỤ ghi trong payload, nếu có. Lưu cạnh received_at để so lệch
// đồng hồ — đây là tín hiệu phụ để phát hiện bản tin phát lại (ADR-0009).
export function cpTimestampOf(action, params) {
  if (!params) return null;
  if (params.timestamp) return params.timestamp;
  if (action === 'MeterValues') return params.meterValue?.[0]?.timestamp ?? null;
  return null;
}

export function openTrace(dir = 'lab/ocpp-traces', prefix = 'trace') {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${prefix}-${now().replace(/[:.]/g, '-')}.jsonl`;
  const stream = createWriteStream(path, { flags: 'a' });

  // epoch = lần kết nối thứ mấy của identity này. Bản tin có cp_timestamp sớm
  // hơn thời điểm mở epoch là ứng viên "phát lại từ hàng đợi offline".
  const epochs = new Map();
  const newEpoch = (cp) => {
    const n = (epochs.get(cp)?.n ?? 0) + 1;
    epochs.set(cp, { n, openedAt: now() });
    return epochs.get(cp);
  };
  const epochOf = (cp) => epochs.get(cp) ?? { n: 0, openedAt: null };

  function write(cp, { message, outbound }) {
    const received_at = now();
    let parsed = null;
    try {
      parsed = JSON.parse(message);
    } catch {}
    const [type, id, a, b] = parsed ?? [];
    const action = type === 2 ? a : null;
    const params = type === 2 ? b : null;
    const epoch = epochOf(cp);
    stream.write(
      JSON.stringify({
        received_at,
        cp,
        dir: outbound ? 'out' : 'in',
        type,
        id,
        action,
        cp_timestamp: cpTimestampOf(action, params),
        epoch: epoch.n,
        epoch_opened_at: epoch.openedAt,
        raw: message,
      }) + '\n',
    );
    return { received_at, type, action };
  }

  return { path, write, newEpoch, epochOf };
}
