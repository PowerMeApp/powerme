/**
 * Screen 18 map against a fake Vietmap GL: a tile error after the style has loaded keeps the map,
 * and a new poll updates the pins in place instead of recreating them.
 */
import { render } from '@testing-library/react';
import type { OperatorChargePoint } from '@powerme/shared';
import { vi } from 'vitest';
import ChargePointMap from '../src/features/chargePoints/ChargePointMap';
import { groupBySite } from '../src/features/chargePoints/mapModel';

const gl = vi.hoisted(() => {
  const handlers: Record<string, (() => void)[]> = {};
  const markers: { el: HTMLElement; removed: boolean }[] = [];
  class Marker {
    entry: { el: HTMLElement; removed: boolean };
    constructor({ element }: { element: HTMLElement }) {
      // Like the real Marker: its own positioning class on the pin element.
      element.classList.add('vietmapgl-marker');
      this.entry = { el: element, removed: false };
      markers.push(this.entry);
    }
    setLngLat() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.entry.removed = true;
    }
  }
  class Map {
    addControl() {}
    on(ev: string, fn: () => void) {
      (handlers[ev] ??= []).push(fn);
    }
    once(ev: string, fn: () => void) {
      this.on(ev, fn);
    }
    jumpTo() {}
    fitBounds() {}
    remove() {}
  }
  class LngLatBounds {
    extend() {}
  }
  const emit = (ev: string) => (handlers[ev] ?? []).forEach((fn) => fn());
  const api = { Map, Marker, LngLatBounds, NavigationControl: class {} };
  return { api, markers, emit, handlers };
});

vi.mock('@vietmap/vietmap-gl-js/dist/vietmap-gl.js', () => ({ ...gl.api, default: gl.api }));

const cp = (
  id: string,
  status: OperatorChargePoint['connectors'][number]['status'],
): OperatorChargePoint => ({
  id,
  serial_number: `RH-${id}`,
  display_code: `PM-${id}`,
  model: null,
  lifecycle: 'in_service',
  connected: true,
  is_online: true,
  last_message_at: new Date().toISOString(),
  site: { id: 's1', site_code: 'Q1', site_name: 'Trạm Quận 1', latitude: 10.77, longitude: 106.7 },
  connectors: [
    {
      connector_id: `${id}1`,
      connector_no: 1,
      connector_type: 'ccs2',
      max_power_kw: 60,
      status,
      status_updated_at: null,
      status_quality: 'fresh',
      error_code: null,
      active_session_id: null,
    },
  ],
  offline_card_risk: false,
  offline_card_risk_reason: null,
});

const props = { tileKey: 'k', selectedId: null, onSelect: () => undefined };

it('a tile error after load keeps the map; a poll repaints the same pin', () => {
  const onError = vi.fn();
  const { rerender } = render(
    <ChargePointMap
      {...props}
      sites={groupBySite([cp('1', 'Available')]).sites}
      onError={onError}
    />,
  );
  expect(gl.markers).toHaveLength(1);
  const pin = gl.markers[0]!.el;
  expect(pin).toHaveClass('tone-ok');
  expect(pin).toHaveAccessibleName('Trạm sạc Trạm Quận 1');

  gl.emit('load');
  gl.emit('error');
  expect(onError).not.toHaveBeenCalled();

  rerender(
    <ChargePointMap {...props} sites={groupBySite([cp('1', 'Faulted')]).sites} onError={onError} />,
  );
  expect(gl.markers).toHaveLength(1);
  expect(gl.markers[0]!.removed).toBe(false);
  expect(pin).toHaveClass('tone-critical');
  expect(pin).not.toHaveClass('tone-ok');
  // The repaint must keep the Marker's class, or the pin leaves the map.
  expect(pin).toHaveClass('vietmapgl-marker');

  rerender(<ChargePointMap {...props} sites={[]} onError={onError} />);
  expect(gl.markers[0]!.removed).toBe(true);
});

it('an error before the style loads reports "load" once', () => {
  for (const k of Object.keys(gl.handlers)) delete gl.handlers[k];
  const onError = vi.fn();
  render(<ChargePointMap {...props} sites={[]} onError={onError} />);
  gl.emit('error');
  gl.emit('error');
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith('load');
});
