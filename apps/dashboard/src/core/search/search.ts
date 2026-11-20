/**
 * Text search helpers (FE-07). `normalizeSearch` matches the CSMS / SQL `powerme_search_text`
 * (NFD, drop combining marks, đ → d, lower case), so a client-side filter finds the same things
 * as the `q` parameter of GET /operator/v1/charge-points.
 */
import { useEffect, useState } from 'react';

export function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().trim();
}

/** True when the normalised query is empty or found in any of the values. */
export function matchesSearch(query: string, values: (string | null | undefined)[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return values.some((v) => v !== null && v !== undefined && normalizeSearch(v).includes(q));
}

/** `value` once it has stopped changing for `ms` (search as you type without a request per key). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Longest search text the API accepts (CSMS: `q` ≤ 100 characters). */
export const MAX_SEARCH = 100;
