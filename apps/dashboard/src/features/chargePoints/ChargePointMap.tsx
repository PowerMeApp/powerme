/**
 * Screen 18 map: Vietmap base map (vector style, Vietmap GL JS), one pin per Charging Station.
 * Loaded with React.lazy so the GL library stays out of the main bundle. Only draws the map; the
 * selected station's details are rendered by the page (testable without WebGL).
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
  /** `webgl`: the browser cannot create a WebGL context; `load`: the style failed (key, quota, network). */
  onError: (reason: MapFailure) => void;
}
export type MapFailure = 'webgl' | 'load';

interface Pin {
  marker: vietmapNs.Marker;
  el: HTMLButtonElement;
}

/**
 * Only our own classes change: the Marker adds `vietmapgl-marker` (absolute position) and anchor
 * classes to the same element, and replacing `className` would drop the pin off the map.
 */
function paint(el: HTMLButtonElement, site: MapSite, selected: boolean) {
  el.classList.add('map-pin');
  for (const c of [...el.classList]) if (c.startsWith('tone-')) el.classList.remove(c);
  el.classList.add(`tone-${site.tone}`);
  el.classList.toggle('selected', selected);
  el.title = `${site.site_name} · ${TONE_LABEL[site.tone]}`;
  el.setAttribute('aria-label', `Trạm sạc ${site.site_name}`);
  el.setAttribute('aria-pressed', String(selected));
  el.textContent = String(site.chargePoints.length);
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
  const pins = useRef(new Map<string, Pin>());
  const fitted = useRef('');
  const callbacks = useRef({ onSelect, onError });
  callbacks.current = { onSelect, onError };

  useEffect(() => {
    if (!container.current) return;
    let m: vietmapNs.Map;
    try {
      m = new vietmapgl.Map({
        container: container.current,
        style: styleUrl(tileKey),
        center: START,
        zoom: 11,
      });
    } catch {
      // The constructor throws when no WebGL context can be created (e.g. a VM with software
      // rendering and WebGL blocked). Report it instead of letting it escape as an uncaught error.
      callbacks.current.onError('webgl');
      return;
    }
    m.addControl(new vietmapgl.NavigationControl({ showCompass: false }), 'top-right');
    // Only a failure before the style has loaded (wrong key, quota, no network) means there is no
    // map. A missing tile or icon later is not fatal: the map stays and the next pan retries it.
    let loaded = false;
    let failed = false;
    m.once('load', () => {
      loaded = true;
    });
    m.on('error', () => {
      if (loaded || failed) return;
      failed = true;
      callbacks.current.onError('load');
    });
    map.current = m;
    const placed = pins.current;
    return () => {
      placed.forEach((p) => p.marker.remove());
      placed.clear();
      fitted.current = '';
      m.remove();
      map.current = null;
    };
  }, [tileKey]);

  // Pins are kept by station id and updated in place on each poll, so they do not flicker and a
  // focused pin keeps its focus; only stations that appear or disappear add or remove a marker.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const current = pins.current;
    const seen = new Set<string>();
    for (const site of sites) {
      seen.add(site.id);
      const existing = current.get(site.id);
      if (existing) {
        paint(existing.el, site, site.id === selectedId);
        existing.marker.setLngLat([site.longitude, site.latitude]);
        continue;
      }
      const el = document.createElement('button');
      el.type = 'button';
      paint(el, site, site.id === selectedId);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        callbacks.current.onSelect(site.id);
      });
      const marker = new vietmapgl.Marker({ element: el })
        .setLngLat([site.longitude, site.latitude])
        .addTo(m);
      current.set(site.id, { marker, el });
    }
    for (const [id, pin] of current) {
      if (seen.has(id)) continue;
      pin.marker.remove();
      current.delete(id);
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
