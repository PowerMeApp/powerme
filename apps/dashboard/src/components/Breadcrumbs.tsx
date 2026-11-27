/**
 * Breadcrumb trail above a page title (Nghĩa 20/11): "Tổng quan › Trụ sạc › Trạm Q1 › PM-001".
 * The first item is the signed-in role's home; the last item is the current page (not a link).
 */
import { Anchor, Breadcrumbs as MantineBreadcrumbs, Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { Link } from 'react-router';
import { homePath } from '../core/auth/authSlice';
import { useAppSelector } from '../core/store/store';

export interface Crumb {
  label: string;
  /** Omitted for the current page, or for a level without its own page. */
  to?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const role = useAppSelector((s) => s.auth.user?.role) ?? 'operator_staff';
  const trail: Crumb[] = [{ label: 'Tổng quan', to: homePath(role) }, ...items];
  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      <MantineBreadcrumbs
        separator={<IconChevronRight size={14} aria-hidden="true" />}
        separatorMargin={6}
      >
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return last ? (
            <Text key={`${i}-${c.label}`} component="span" size="sm" aria-current="page">
              {c.label}
            </Text>
          ) : c.to ? (
            <Anchor key={`${i}-${c.label}`} component={Link} to={c.to} size="sm" c="dimmed">
              {c.label}
            </Anchor>
          ) : (
            <Text key={`${i}-${c.label}`} component="span" size="sm" c="dimmed">
              {c.label}
            </Text>
          );
        })}
      </MantineBreadcrumbs>
    </nav>
  );
}
