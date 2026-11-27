/**
 * Top of every screen: breadcrumbs, the title, a dimmed subtitle and the screen's actions on the
 * right (they wrap under the title on narrow screens).
 */
import { Group, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import { Breadcrumbs, type Crumb } from '../components/Breadcrumbs';

export function PageHeader({
  crumbs,
  title,
  subtitle,
  badges,
  actions,
}: {
  crumbs?: Crumb[];
  title: ReactNode;
  subtitle?: ReactNode;
  /** Status badges next to the title (charge point detail). */
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      {crumbs && <Breadcrumbs items={crumbs} />}
      <div className="page-head">
        <div className="page-head-text">
          <Group gap="sm" align="center" wrap="wrap">
            <Title order={1}>{title}</Title>
            {badges}
          </Group>
          {subtitle && (
            <Text component="div" c="dimmed" className="page-subtitle">
              {subtitle}
            </Text>
          )}
        </div>
        {actions && (
          <Group gap="sm" className="page-action">
            {actions}
          </Group>
        )}
      </div>
    </header>
  );
}

/** A titled block inside a screen (h2 + optional actions). */
export function Section({
  label,
  title = label,
  actions,
  children,
  className,
}: {
  label: string;
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={label} className={`page-section${className ? ` ${className}` : ''}`}>
      <div className="section-head">
        <Title order={2} className="section-title">
          {title}
        </Title>
        {actions}
      </div>
      {children}
    </section>
  );
}
