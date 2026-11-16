import {
  checkTariffTime,
  ClockFrame,
  measureClockOffset,
  parseChargePointTime,
  readChargePointTime,
} from './tariff-clock.js';

const time = (ms: number) => new Date(Date.UTC(2026, 10, 11, 5) + ms);
const receipt = {
  receivedAt: time(60000),
  openedAt: time(30000),
  closedAt: null,
  firstOpenedAt: time(0),
  epoch: 2,
};

describe('T101 charge-point tariff clock', () => {
  it.each([
    '2026-02-30T05:00:00Z',
    '2026-11-11T24:00:00Z',
    '2026-11-11T05:00:00',
    '2026-11-11T05:00:00.0001Z',
    'invalid',
  ])('rejects invalid or ambiguous raw timestamp %s', (raw) => {
    expect(parseChargePointTime(raw)).toBeNull();
  });

  it('normalizes explicit ICT offset to the same UTC instant', () => {
    expect(parseChargePointTime('2026-11-11T12:00:00+07:00')).toEqual(time(0));
    expect(parseChargePointTime('2026-11-11T05:00:00.120000Z')).toEqual(time(120));
  });

  it('T134 still reads a timestamp without a zone or with a sub-millisecond fraction, marked inexact', () => {
    expect(readChargePointTime('2026-11-11T05:00:00')).toEqual({ at: time(0), exact: false });
    expect(readChargePointTime('2026-11-11T05:00:00.1239Z')).toEqual({
      at: time(123),
      exact: false,
    });
    expect(readChargePointTime('2026-11-11T12:00:00.5+07:00')).toEqual({
      at: time(500),
      exact: true,
    });
    for (const raw of ['2026-02-30T05:00:00', '2026-11-11T24:00:00', '2026-11-11 05:00:00', 5])
      expect(readChargePointTime(raw)).toBeNull();
  });

  it('uses the tariff tolerance inclusively for live frames and rejects future lead', () => {
    expect(checkTariffTime(time(65000), receipt, 5000)).toBeUndefined();
    expect(checkTariffTime(time(65001), receipt, 5000)).toBe('tariff_clock_future_timestamp');
  });

  it('accepts a prior-epoch event with known history regardless of delivery delay', () => {
    expect(checkTariffTime(time(20000), receipt, 5000)).toBeUndefined();
    expect(checkTariffTime(time(20000), { ...receipt, firstOpenedAt: null }, 5000)).toBe(
      'tariff_clock_epoch_unverified',
    );
  });

  it('T134 accepts a same-epoch frame that arrives later than the tolerance (backfill)', () => {
    expect(checkTariffTime(time(40000), receipt, 5000)).toBeUndefined();
  });

  it('rejects missing or invalid CSMS receipt evidence and receipts after close', () => {
    expect(checkTariffTime(time(60000), { ...receipt, openedAt: null }, 5000)).toBe(
      'tariff_clock_epoch_unverified',
    );
    expect(checkTariffTime(time(60000), { ...receipt, receivedAt: new Date(NaN) }, 5000)).toBe(
      'tariff_clock_epoch_unverified',
    );
    expect(checkTariffTime(time(60000), { ...receipt, closedAt: time(59999) }, 5000)).toBe(
      'tariff_clock_epoch_unverified',
    );
  });
});

describe('T134 clock offset measured on live frames of one connection epoch', () => {
  const TOLERANCE = 300_000;
  const LIVE = 5_000;
  /** Bản tin trụ ghi lúc `cpS` giây, CSMS nhận lúc `receivedS` giây. */
  const frame = (cpS: number, receivedS: number, epoch = 1): ClockFrame => ({
    epoch,
    cp: time(cpS * 1000),
    receivedAt: time(receivedS * 1000),
  });
  const measure = (frames: ClockFrame[]) => measureClockOffset(frames, TOLERANCE, LIVE);

  it.each([600, -600])(
    'takes the median offset of the live frames (%s s), whichever way the clock is off',
    (offset) => {
      expect(
        measure([
          frame(0, offset + 0.2),
          frame(60, 60 + offset + 0.1),
          frame(120, 120 + offset + 0.4),
        ]),
      ).toEqual({ offsetMs: offset * 1000 + 200, epoch: 1, liveFrames: 3 });
    },
  );

  it('averages the two middle offsets for an even number of live frames', () => {
    expect(measure([frame(0, 600), frame(60, 661)])).toEqual({
      offsetMs: 600_500,
      epoch: 1,
      liveFrames: 2,
    });
  });

  it('leaves backfilled frames out: waiting in the offline queue only makes the offset larger', () => {
    // Trụ chậm 600 s. Ba mẫu phát bù tới thành một loạt (chờ 430, 420, 410 s) rồi hai mẫu live.
    expect(
      measure([
        frame(0, 1030),
        frame(10, 1030.1),
        frame(20, 1030.2),
        frame(440, 1040),
        frame(450, 1050),
      ]),
    ).toEqual({ offsetMs: 600_000, epoch: 1, liveFrames: 2 });
  });

  it('does not take a burst of queued frames, or a single frame, as a measurement', () => {
    // Phiên diễn ra hoàn toàn offline: mọi bản tin tới trong một loạt sau khi nối lại.
    expect(measure([frame(0, 7200), frame(10, 7200.1), frame(20, 7200.2)])).toBeUndefined();
    // Hai bản tin cách nhau chưa tới ngưỡng live trên đồng hồ trụ có thể cùng nằm trong một loạt.
    expect(measure([frame(0, 7200), frame(4, 7200.1)])).toBeUndefined();
    expect(measure([frame(0, 600)])).toBeUndefined();
    expect(measure([])).toBeUndefined();
  });

  it('measures each epoch on its own and keeps the first measurable one', () => {
    expect(
      measure([frame(0, 9000, 1), frame(100, 700, 2), frame(160, 760, 2), frame(220, 900, 3)]),
    ).toEqual({ offsetMs: 600_000, epoch: 2, liveFrames: 2 });
    expect(
      measure([frame(0, 600, 1), frame(60, 660, 1), frame(500, 1000, 2), frame(560, 1060, 2)]),
    ).toEqual({ offsetMs: 600_000, epoch: 1, liveFrames: 2 });
  });

  it('reports an unstable clock when two epochs disagree by more than the tolerance', () => {
    expect(
      measure([frame(0, 600, 1), frame(60, 660, 1), frame(500, 500, 2), frame(560, 560, 2)]),
    ).toBe('tariff_clock_offset_unstable');
    expect(
      measure([frame(0, 600, 1), frame(60, 660, 1), frame(500, 800, 2), frame(560, 860, 2)]),
    ).toEqual({ offsetMs: 600_000, epoch: 1, liveFrames: 2 });
  });
});
