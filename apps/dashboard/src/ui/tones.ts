/**
 * One tone vocabulary for every badge, row accent and notice (redesign: replaces the per-page
 * pill classes). The tone names are the old `.pill` modifiers, so feature label maps
 * (`[label, tone]`) keep working unchanged.
 */
export type Tone = '' | 'ok' | 'critical' | 'major' | 'minor' | 'muted' | 'none' | 'gold';

/** Mantine colour (ui/theme.ts) for each tone. */
export function toneColor(tone: string): string {
  switch (tone) {
    case 'critical':
    case 'error':
      return 'danger';
    case 'major':
    case 'warn':
      return 'warning';
    case 'muted':
    case 'none':
      return 'slate';
    case 'gold':
      return 'gold';
    default:
      return 'teal';
  }
}

/** FaultEvent severity → tone (critical red, major amber, minor teal, none grey). */
export const SEVERITY_TONE = {
  critical: 'critical',
  major: 'major',
  minor: 'minor',
  none: 'none',
} as const;

/** Online / offline badge, the same on screens 18, 20, 31 and the station page. */
export const onlineBadge = (offline: boolean) =>
  offline ? (['Mất kết nối', 'muted'] as const) : (['Đang kết nối', ''] as const);
