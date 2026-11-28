/**
 * FE-03c: the real map component when the browser cannot create a WebGL context (Chrome in a VM
 * with software rendering). The Vietmap GL constructor throws; it must be reported, not escape.
 */
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import ChargePointMap from '../src/features/chargePoints/ChargePointMap';

vi.mock('@vietmap/vietmap-gl-js/dist/vietmap-gl.js', () => {
  const api = {
    Map: vi.fn(function () {
      throw new Error('Failed to initialize WebGL');
    }),
    NavigationControl: vi.fn(),
    Marker: vi.fn(),
    LngLatBounds: vi.fn(),
  };
  // The real package is UMD/CommonJS: Vite exposes it as `default` too.
  return { ...api, default: api };
});

it('a WebGL failure in the constructor is reported as "webgl", not thrown', () => {
  const onError = vi.fn();
  expect(() =>
    render(
      <ChargePointMap
        tileKey="k"
        sites={[]}
        selectedId={null}
        onSelect={() => undefined}
        onError={onError}
      />,
    ),
  ).not.toThrow();
  expect(onError).toHaveBeenCalledWith('webgl');
});
