/** Navigation icons, from Tabler (outlined, stroke 1.8 like the app's Material outlined set). */
import {
  IconAlertTriangle,
  IconCreditCard,
  IconLayoutDashboard,
  IconListCheck,
  IconLogout,
  IconPlug,
  IconReceipt,
  IconReportMoney,
  IconTag,
  IconTopologyStar3,
  IconUsers,
} from '@tabler/icons-react';

const ICONS = {
  dashboard: IconLayoutDashboard,
  logout: IconLogout,
  alert: IconAlertTriangle,
  network: IconTopologyStar3,
  plug: IconPlug,
  sessions: IconListCheck,
  revenue: IconReportMoney,
  card: IconCreditCard,
  tag: IconTag,
  receipt: IconReceipt,
  users: IconUsers,
} as const;

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS; size?: number }) {
  const C = ICONS[name];
  return <C size={size} stroke={1.8} aria-hidden="true" />;
}
