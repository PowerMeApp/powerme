import { parseSessionListQuery, sessionInteger } from '../src/driver/driver-sessions.js';

describe('T146 session list validation and safe integer output', () => {
  it('defaults and bounds match the credit ledger contract', () => {
    expect(parseSessionListQuery(new URLSearchParams())).toEqual({
      view: 'all',
      page: 1,
      pageSize: 20,
    });
    expect(
      parseSessionListQuery(new URLSearchParams('view=active&page=100000&page_size=100')),
    ).toEqual({ view: 'active', page: 100000, pageSize: 100 });
  });
  it.each([
    'view=stopped',
    'view=',
    'view=all&view=active',
    'driver_id=1',
    'id_tag=card',
    'page=0',
    'page=-1',
    'page=1.5',
    'page=100001',
    'page=999999999999999999999',
    'page=1&page=1',
    'page_size=0',
    'page_size=101',
    'page=1e2',
    'page=01',
    'page=1%0A',
    'page_size=20%0D',
    'page=1%3BDROP%20TABLE%20sessions',
    'unknown=1',
  ])('rejects %s', (query) => {
    expect(() => parseSessionListQuery(new URLSearchParams(query))).toThrow(
      expect.objectContaining({ status: 400, code: 'invalid_input' }),
    );
  });
  it('keeps unknown null and refuses unsafe integer telemetry', () => {
    expect(sessionInteger(null)).toBeNull();
    expect(sessionInteger('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => sessionInteger('9007199254740992')).toThrow('session_integer_out_of_range');
    expect(() => sessionInteger('1.5')).toThrow('session_integer_out_of_range');
  });
});
