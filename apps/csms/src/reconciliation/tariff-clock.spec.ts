import {
  checkTariffTime,
  ClockFrame,
  measureClockOffset,
  meterAt,
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
    expect(readChargePointTime('2026-11-11T05:00:00')).toEqual({
      at: time(0),
      exact: false,
      zoned: false,
    });
    expect(readChargePointTime('2026-11-11T05:00:00.1239Z')).toEqual({
      at: time(123),
      exact: false,
      zoned: true,
    });
    expect(readChargePointTime('2026-11-11T12:00:00.5+07:00')).toEqual({
      at: time(500),
      exact: true,
      zoned: true,
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
  const UNSTABLE = 'tariff_clock_offset_unstable';
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
    // Trụ chậm 600 s. Ba mẫu phát bù tới thành một loạt (chờ 430, 420, 410 s) rồi ba mẫu live.
    expect(
      measure([
        frame(0, 1030),
        frame(10, 1030.1),
        frame(20, 1030.2),
        frame(440, 1040),
        frame(450, 1050),
        frame(460, 1060),
      ]),
    ).toEqual({ offsetMs: 600_000, epoch: 1, liveFrames: 3 });
  });

  it('does not take a burst of queued frames, or a single frame, as a measurement', () => {
    // Phiên diễn ra hoàn toàn offline: mọi bản tin tới trong một loạt sau khi nối lại.
    expect(measure([frame(0, 7200), frame(10, 7200.1), frame(20, 7200.2)])).toBeUndefined();
    expect(measure([frame(0, 600)])).toBeUndefined();
    expect(measure([])).toBeUndefined();
  });

  it('H2: needs three paced frames or 60 s on the charge point clock before a group counts as live', () => {
    // Mẫu cuối 11:49:55,0 và stop 11:50:00,5 phát bù lúc 12:30, tới cách nhau 0,6 s: độ lệch của
    // hai bản tin chỉ khác nhau 4,9 s nhưng đây là một loạt phát bù, không phải đồng hồ chậm 2403 s.
    expect(measure([frame(-5.5, 2400), frame(0, 2400.6)])).toBeUndefined();
    // Ba bản tin trong 6 giây giờ trụ vẫn có thể là một loạt phát bù.
    expect(measure([frame(0, 2400), frame(3, 2400.3), frame(6, 2400.6)])).toBeUndefined();
    // Hai bản tin live cách nhau chưa tới 60 s không đủ; thêm bản tin thứ ba thì đủ.
    expect(measure([frame(0, 600), frame(30, 630)])).toBeUndefined();
    expect(measure([frame(0, 600), frame(15, 615), frame(30, 630)])).toEqual({
      offsetMs: 600_000,
      epoch: 1,
      liveFrames: 3,
    });
  });

  it.each([
    ['slow then synced', 600, 0],
    ['fast then synced', -600, 0],
  ])('H1: a clock corrected inside one epoch (%s) is unstable', (_name, before, after) => {
    expect(
      measure([
        frame(0, before),
        frame(60, 60 + before),
        frame(120, 120 + before),
        frame(200, 200 + after),
        frame(260, 260 + after),
        frame(320, 320 + after),
      ]),
    ).toBe(UNSTABLE);
  });

  it('keeps the least delayed of two live groups that agree within the tolerance', () => {
    // Nhóm thứ hai chậm đều 100 s (mạng nghẽn): cùng một đồng hồ, lấy nhóm ít chờ nhất.
    expect(
      measure([frame(0, 0), frame(60, 60), frame(200, 300), frame(260, 360), frame(320, 420)]),
    ).toEqual({ offsetMs: 0, epoch: 1, liveFrames: 2 });
  });

  it('decision 4: a clock that is off must be measured, and agree, in every epoch of the session', () => {
    // Hai epoch đều đo được và khớp nhau trong dung sai → dùng số đo của epoch đầu.
    expect(
      measure([frame(0, 600, 1), frame(60, 660, 1), frame(500, 1000, 2), frame(560, 1060, 2)]),
    ).toEqual({ offsetMs: 600_000, epoch: 1, liveFrames: 2 });
    // Lệch nhau quá dung sai (đồng hồ được chỉnh lúc nối lại).
    expect(
      measure([frame(0, 600, 1), frame(60, 660, 1), frame(500, 500, 2), frame(560, 560, 2)]),
    ).toBe(UNSTABLE);
    // H3: epoch sau chỉ có một bản tin, không đo được → không được nhận độ lệch của epoch đầu.
    expect(measure([frame(0, -600, 1), frame(60, -540, 1), frame(900, 900, 2)])).toBe(UNSTABLE);
    expect(measure([frame(0, 9000, 1), frame(100, 700, 2), frame(160, 760, 2)])).toBe(UNSTABLE);
  });

  it('does not need every epoch when the measured clock is within the tolerance', () => {
    expect(measure([frame(0, 2, 1), frame(60, 62, 1), frame(100, 9000, 2)])).toEqual({
      offsetMs: 2000,
      epoch: 1,
      liveFrames: 2,
    });
  });
});

describe('T134 meter reading at a tariff boundary', () => {
  const points = [
    { at: 0, wh: 1000 },
    { at: 60_000, wh: 1200 },
    { at: 180_000, wh: 1800 },
  ];

  it('uses a reading taken exactly on the boundary as it is', () => {
    expect(meterAt(points, 60_000)).toEqual({ wh: 1200, gapMs: 0 });
  });

  it('interpolates linearly between the two readings around the boundary', () => {
    expect(meterAt(points, 90_000)).toEqual({ wh: 1350, gapMs: 120_000 });
    expect(meterAt(points, 15_000)).toEqual({ wh: 1050, gapMs: 60_000 });
  });

  it('has no reading outside the series', () => {
    expect(meterAt(points, -1)).toBeNull();
    expect(meterAt(points, 180_001)).toBeNull();
  });
});
