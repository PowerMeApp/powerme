/**
 * InboundSerializer — hàng đợi promise theo từng trụ: handler CALL chiều vào chạy TUẦN TỰ.
 *
 * Vì sao tồn tại: ADR-0004 "ba điều ocpp-rpc không làm" #1 — thư viện giới hạn CALL chiều ra
 * (callConcurrency = 1) nhưng KHÔNG giới hạn chiều vào. Trụ đang phát lại hàng đợi offline có
 * thể gửi dồn (EXP-01 giai đoạn E–F: StopTransaction rồi 6 MeterValues trong vài giây). Nếu
 * handler chạy song song, dedup/đối soát đọc DB khi dòng trước chưa ghi xong → sai thứ tự.
 *
 * Cách làm: mỗi key (identity trụ) giữ "đuôi" của chuỗi promise; tác vụ mới nối vào sau đuôi,
 * bất kể tác vụ trước thành công hay lỗi. Hai trụ khác nhau không chặn nhau.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class InboundSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  /** Chạy `task` sau khi mọi tác vụ cùng `key` đã xong; trả về kết quả của chính task. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(() => task());
    const settled: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return next;
  }

  /** Số key đang có tác vụ chưa xong (phục vụ test / quan sát). */
  get activeKeys(): number {
    return this.tails.size;
  }
}
