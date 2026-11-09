import { DEFAULT_SMART_SEARCH, loadSmartSearchConfig } from './smart-search.js';

it('loads the brief assumptions and supports bounded process configuration', () => {
  expect(loadSmartSearchConfig({})).toEqual(DEFAULT_SMART_SEARCH);
  expect(loadSmartSearchConfig({ SMART_SEARCH_AVG_SPEED_KMH: '40' }).avg_speed_kmh).toBe(40);
});

it.each([
  ['CHARGE_EFFICIENCY', '0'],
  ['CHARGE_EFFICIENCY', '1e-300'],
  ['RANGE_FACTOR', '2'],
  ['ROAD_FACTOR', '0.5'],
  ['RESERVE_KM', '-1'],
  ['AVG_SPEED_KMH', 'NaN'],
  ['AVG_SPEED_KMH', 'Infinity'],
  ['RADIUS_FACTOR', '1e308'],
  ['FALLBACK_LIMIT', '1.5'],
  ['IN_USE_WAIT_MIN', '1e308'],
  ['FREEING_SOON_WAIT_MIN', '-1'],
])('rejects invalid or numerically unsafe assumption %s=%s', (key, value) => {
  expect(() => loadSmartSearchConfig({ [`SMART_SEARCH_${key}`]: value })).toThrow();
});
