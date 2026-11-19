/**
 * Screen 18 map (FE-03c) — pure model: one pin per Charging Station, coloured by the worst state
 * of its charge points. Kept free of the map library so it can be unit tested in jsdom.
 */
import type { ConnectorLive, OperatorChargePoint } from '@powerme/shared';

/** Worst first: Offline overrides every status (D20), then faults, then use. */
export type SiteTone = 'offline' | 'critical' | 'major' | 'busy' | 'ok' | 'empty';
export const TONE_ORDER: readonly SiteTone[] = [
  'offline',
  'critical',
  'major',
  'busy',
  'ok',
  'empty',
];
export const TONE_LABEL: Record<SiteTone, string> = {
  offline: 'Offline',
  critical: 'Có Connector Faulted',
  major: 'Có Connector Unavailable / Reserved',
  busy: 'Đang dùng',
  ok: 'Sẵn sàng',
  empty: 'Chưa có Connector',
};

export interface MapSite {
  id: string;
  site_code: string;
  site_name: string;
  latitude: number;
  longitude: number;
  tone: SiteTone;
  chargePoints: OperatorChargePoint[];
}

export const isOffline = (cp: OperatorChargePoint) =>
  !cp.is_online || cp.connectors.some((c) => c.status_quality === 'offline');

function connectorTone(c: ConnectorLive): SiteTone {
  if (c.status_quality === 'offline') return 'offline';
  if (c.status === 'Faulted') return 'critical';
  if (c.status === 'Unavailable' || c.status === 'Reserved') return 'major';
  if (c.status === 'Available') return 'ok';
  return 'busy';
}

const worst = (tones: SiteTone[]): SiteTone =>
  tones.reduce<SiteTone>(
    (a, b) => (TONE_ORDER.indexOf(b) < TONE_ORDER.indexOf(a) ? b : a),
    'empty',
  );

export function chargePointTone(cp: OperatorChargePoint): SiteTone {
  return isOffline(cp) ? 'offline' : worst(cp.connectors.map(connectorTone));
}

/**
 * Group charge points by Charging Station, in the order the list returns them. Stations without
 * coordinates cannot be placed and are counted in `unplaced` instead.
 */
export function groupBySite(items: readonly OperatorChargePoint[]): {
  sites: MapSite[];
  unplaced: number;
} {
  const sites = new Map<string, MapSite>();
  const unplaced = new Set<string>();
  for (const cp of items) {
    const { id, site_code, site_name, latitude, longitude } = cp.site;
    if (
      latitude === null ||
      longitude === null ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      unplaced.add(id);
      continue;
    }
    const site = sites.get(id) ?? {
      id,
      site_code,
      site_name,
      latitude,
      longitude,
      tone: 'empty' as SiteTone,
      chargePoints: [],
    };
    site.chargePoints.push(cp);
    sites.set(id, site);
  }
  const placed = [...sites.values()].map((s) => ({
    ...s,
    tone: worst(s.chargePoints.map(chargePointTone)),
  }));
  return { sites: placed, unplaced: unplaced.size };
}
