/**
 * Realtime (PKG-2: core/realtime). Đích là Socket.IO (BE-08, chưa có) để trạng thái hiện trên
 * dashboard trong 3 s (NFR form v1.3). Tạm thời các màn hình theo dõi dùng `pollingInterval` của
 * RTK Query với chu kỳ này — cùng ngân sách 3 s.
 */
export const LIVE_POLL_MS = 3_000;
/** Màn hình đang đếm ngược Reset cần nhịp dày hơn. */
export const FAST_POLL_MS = 1_000;
