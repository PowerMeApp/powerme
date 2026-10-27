/** Cấu hình dashboard (PKG-2: core/config). */
export const env = {
  /** Toàn bộ dữ liệu đang là mock (src/mocks). Đổi khi nối REST API thật của CSMS. */
  useMock: true,
  appName: 'PowerMe',
} as const;
