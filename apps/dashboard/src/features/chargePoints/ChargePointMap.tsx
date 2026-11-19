/**
 * Screen 18 map (FE-03c): Vietmap base map (vector style, Vietmap GL JS), one pin per Charging
 * Station. Loaded with React.lazy so the GL library stays out of the main bundle. Only draws the
 * map; the selected station's details are rendered by the page (testable without WebGL).
 *
 * The package has no `main` / `exports` entry, so the UMD build is imported by path; Vite
 * pre-bundles it as CommonJS.
 */
import { useEffect, useRef } from 'react';
import * as vietmapNs from '@vietmap/vietmap-gl-js/dist/vietmap-gl.js';
import '@vietmap/vietmap-gl-js/dist/vietmap-gl.css';
import { TONE_LABEL, type MapSite } from './mapModel';

const vietmapgl: typeof vietmapNs =
  (vietmapNs as unknown as { default?: typeof vietmapNs }).default ?? vietmapNs;

/** Dark style, to match the dashboard theme and the driver app (`dm`). */
const styleUrl = (key: string) =>
  `https://maps.vietmap.vn/maps/styles/dm/style.json?apikey=${encodeURIComponent(key)}`;
/** Ho Chi Minh City until the stations are known. */
const START: [number, number] = [106.7, 10.78];

export interface ChargePointMapProps {
  tileKey: string;
  sites: MapSite[];
  selectedId: string | null;
  onSelect: (siteId: string) => void;
  onError: () => void;
}

export default function ChargePointMap({
  tileKey,
  sites,
  selectedId,
  onSelect,
  onError,
}: ChargePointMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<vietmapNs.Map | null>(null);
  const markers = useRef(new Map<string, vietmapNs.Marker>());
  const fitted = useRef('');
  const callbacks = useRef({ onSelect, onError });
  callbacks.current = { onSelect, onError };

  useEffect(() => {
    if (!container.current) return;
    const m = new vietmapgl.Map({
      container: container.current,
      style: styleUrl(tileKey),
      center: START,
      zoom: 11,
    });
    m.addControl(new vietmapgl.NavigationControl({ showCompass: false }), 'top-right');
    let failed = false;
    m.on('error', () => {
      if (failed) return;
      failed = true;
      callbacks.current.onError();
    });
    map.current = m;
    const placed = markers.current;
    return () => {
      placed.forEach((marker) => marker.remove());
      placed.clear();
      fitted.current = '';
      m.remove();
      map.current = null;
    };
  }, [tileKey]);

  // Pins: rebuilt on each poll (cheap for ≤ 100 charge points), kept in step with the list.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    markers.current.forEach((marker) => marker.remove());
    markers.current.clear();
    for (const site of sites) {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = `map-pin tone-${site.tone}${site.id === selectedId ? ' selected' : ''}`;
      pin.title = `${site.site_name} · ${TONE_LABEL[site.tone]}`;
      pin.setAttribute('aria-label', `Charging Station ${site.site_name}`);
      pin.textContent = String(site.chargePoints.length);
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        callbacks.current.onSelect(site.id);
      });
      markers.current.set(
        site.id,
        new vietmapgl.Marker({ element: pin }).setLngLat([site.longitude, site.latitude]).addTo(m),
      );
    }
    // Re-frame only when the set of stations changes (filters), not on every poll.
    const key = sites
      .map((s) => s.id)
      .sort()
      .join(',');
    if (key && key !== fitted.current) {
      fitted.current = key;
      const [first, ...rest] = sites;
      if (rest.length === 0) m.jumpTo({ center: [first!.longitude, first!.latitude], zoom: 14 });
      else {
        const bounds = new vietmapgl.LngLatBounds();
        for (const s of sites) bounds.extend([s.longitude, s.latitude]);
        m.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 0 });
      }
    }
  }, [sites, selectedId]);

  return <div ref={container} className="map-canvas" data-testid="vietmap" />;
}
