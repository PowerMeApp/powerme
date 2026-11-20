/**
 * Breadcrumb trail above a page title (Nghĩa 20/11): "Tổng quan › Trụ sạc › Trạm Q1 › PM-001".
 * The first item is the signed-in role's home; the last item is the current page (not a link).
 */
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
      <ol>
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={`${i}-${c.label}`}>
              {last ? (
                <span aria-current="page">{c.label}</span>
              ) : c.to ? (
                <Link to={c.to}>{c.label}</Link>
              ) : (
                <span>{c.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
