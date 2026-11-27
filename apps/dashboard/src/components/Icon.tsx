/** Small SVG icon set (stroke 1.8, like the app's Material outlined); no icon library. */
const PATHS = {
  dashboard: 'M3 3h8v10H3zM13 3h8v6h-8zM13 11h8v10h-8zM3 15h8v6H3z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.01',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0zM12 18v4',
  sessions: 'M4 5h16M4 12h16M4 19h10M18 17l2 2 3-4',
  revenue: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5v.01',
  users:
    'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21v-1a6 6 0 0112 0v1M17 11a3 3 0 100-6M22 21v-1a5 5 0 00-4-4.9',
} as const;

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS; size?: number }) {
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
      <path d={PATHS[name]} />
    </svg>
  );
}
