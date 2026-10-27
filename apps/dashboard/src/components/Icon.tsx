/** Bộ icon SVG nhỏ (nét 1.8, giống Material outlined của app) — không thêm thư viện icon. */
const PATHS: Record<string, string> = {
  dashboard: 'M3 3h8v10H3zM13 3h8v6h-8zM13 11h8v10h-8zM3 15h8v6H3z',
  pillar: 'M7 2h8v20H7zM15 7h2a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2M11 6l-2 4h4l-2 4',
  alert: 'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
  session: 'M4 5h16v14H4zM4 9h16M9 13h6',
  tariff: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  ticket: 'M3 7h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4zM12 7v12',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  users:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-5-6',
  device: 'M4 4h16v12H4zM8 20h8M12 16v4',
  card: 'M2 6h20v12H2zM2 10h20M6 15h4',
  billing: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6',
  policy: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h5',
  health: 'M3 12h4l3-8 4 16 3-8h4',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  plus: 'M12 5v14M5 12h14',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  check: 'M5 13l4 4L19 7',
  reset: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
  wifiOff:
    'M2 2l20 20M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M5 12.5a10 10 0 0 1 5-2.8M16.7 10.2A10 10 0 0 1 19 12.5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] ?? PATHS['dashboard']} />
    </svg>
  );
}
