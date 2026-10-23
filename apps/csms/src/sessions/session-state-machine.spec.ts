/**
 * Unit test SessionStateMachine — không DB.
 *
 * Một test cho MỖI chuyển hợp lệ của T13 mục 1.2 (tên test = số thứ tự T13), và một nhóm test
 * cho chuyển không hợp lệ bị từ chối bằng InvalidTransitionError (T13 mục 6, T33).
 */
import {
  INITIAL,
  InvalidTransitionError,
  SESSION_STATUSES,
  SessionEvent,
  SessionStateMachine,
  SessionStatus,
  TRANSITIONS,
} from './session-state-machine.js';

const sm = new SessionStateMachine();

type Row = [
  no: string,
  from: SessionStatus | null,
  event: SessionEvent,
  to: SessionStatus,
  note: string,
];

/** 22 chuyển của T13 mục 1.2 (16a có hai trigger → 23 dòng). */
const T13: Row[] = [
  ['1', INITIAL, 'REMOTE_START_ACCEPTED', 'pending', 'RemoteStart Accepted'],
  [
    '2',
    INITIAL,
    'START_TRANSACTION',
    'active',
    'StartTransaction không có pending khớp (RFID/HMI/free vend)',
  ],
  ['3', 'pending', 'START_TRANSACTION', 'active', 'StartTransaction cùng connector, cùng idTag'],
  ['4', 'pending', 'START_TIMEOUT', 'failed', 'start timeout 120 s'],
  ['5', 'active', 'STATUS_SUSPENDED', 'paused', 'StatusNotification SuspendedEV/EVSE'],
  ['6', 'paused', 'STATUS_CHARGING', 'active', 'StatusNotification Charging'],
  ['7', 'active', 'STOP_REQUESTED', 'stopping', 'điều kiện dừng → RemoteStop'],
  ['8', 'paused', 'STOP_REQUESTED', 'stopping', 'driver bấm Stop → RemoteStop'],
  ['9a', 'stopping', 'REMOTE_STOP_REJECTED', 'active', 'RemoteStopTransaction trả Rejected'],
  ['9', 'stopping', 'STOP_TRANSACTION', 'closed', 'StopTransaction tới'],
  ['10', 'active', 'STOP_TRANSACTION', 'closed', 'StopTransaction tới (đầy pin / dừng tại trụ)'],
  ['11', 'paused', 'STOP_TRANSACTION', 'closed', 'StopTransaction tới'],
  ['12', 'closed', 'RECONCILE_OK', 'reconciled', 'đối soát nhất quán'],
  ['12a', 'closed', 'RECONCILE_CONFLICT', 'review', 'đối soát conflict (EXP-01)'],
  ['13', 'active', 'STATION_OFFLINE', 'orphaned', 'trụ offline'],
  ['14', 'paused', 'STATION_OFFLINE', 'orphaned', 'trụ offline'],
  ['15', 'stopping', 'STATION_OFFLINE', 'orphaned', 'trụ offline'],
  ['16', 'orphaned', 'RECONCILE_OK', 'reconciled', 'StopTransaction phát lại, nhất quán'],
  ['16a', 'orphaned', 'RECONCILE_CONFLICT', 'review', 'StopTransaction phát lại, conflict'],
  ['16a', 'orphaned', 'HARD_CAP_EXCEEDED', 'review', 'không có StopTransaction sau hard cap 24 h'],
  ['17', 'review', 'OPERATOR_RESOLVED', 'reconciled', 'operator giải quyết'],
  ['18', 'orphaned', 'LIVE_MESSAGE', 'active', 'bản tin live tới sau nối lại (EXP-01 giai đoạn D)'],
  ['19', 'reconciled', 'LATE_SAMPLE_CONFLICT', 'review', 'mẫu muộn đổi kết luận, chưa trừ tiền'],
];

describe('SessionStateMachine — 22 chuyển hợp lệ của T13 mục 1.2', () => {
  it.each(T13)('T13 #%s: %s --%s--> %s (%s)', (_no, from, event, to) => {
    expect(sm.canApply(from, event)).toBe(true);
    expect(sm.apply(from, event)).toBe(to);
  });

  it('bảng TRANSITIONS có đúng 22 số thứ tự T13 (16a hai trigger) và khớp bảng test', () => {
    const numbers = new Set(TRANSITIONS.map((t) => t.no));
    expect(numbers.size).toBe(22);
    expect(TRANSITIONS).toHaveLength(T13.length);
    for (const [no, from, event, to] of T13) {
      expect(TRANSITIONS).toContainEqual({ no, from, event, to });
    }
  });

  it('có đủ 9 trạng thái và mọi trạng thái đều xuất hiện trong bảng', () => {
    expect(SESSION_STATUSES).toHaveLength(9);
    const seen = new Set<string>();
    for (const t of TRANSITIONS) {
      if (t.from !== null) seen.add(t.from);
      seen.add(t.to);
    }
    for (const s of SESSION_STATUSES) expect(seen.has(s)).toBe(true);
  });
});

describe('SessionStateMachine — chuyển không hợp lệ bị từ chối', () => {
  const invalid: [SessionStatus | null, SessionEvent][] = [
    ['reconciled', 'START_TRANSACTION'], // reconciled → active: không có
    ['reconciled', 'LIVE_MESSAGE'],
    ['failed', 'START_TRANSACTION'], // failed → *: trạng thái cuối
    ['failed', 'STATION_OFFLINE'],
    ['failed', 'OPERATOR_RESOLVED'],
    ['pending', 'STATUS_SUSPENDED'], // pending → paused: chưa sạc thì không tạm dừng
    ['pending', 'STOP_TRANSACTION'],
    ['closed', 'STATION_OFFLINE'], // đã có StopTransaction thì không orphaned
    ['closed', 'STOP_TRANSACTION'], // StopTransaction lặp
    ['review', 'RECONCILE_OK'], // review chỉ ra bằng operator (#17)
    ['active', 'OPERATOR_RESOLVED'],
    ['active', 'LIVE_MESSAGE'], // #18 chỉ từ orphaned
    [INITIAL, 'STOP_TRANSACTION'],
    [INITIAL, 'STATION_OFFLINE'],
  ];

  it.each(invalid)('%s --%s--> ném InvalidTransitionError', (from, event) => {
    expect(sm.canApply(from, event)).toBe(false);
    expect(() => sm.apply(from, event)).toThrow(InvalidTransitionError);
  });

  it('InvalidTransitionError mang from/event để log được', () => {
    try {
      sm.apply('reconciled', 'START_TRANSACTION');
      fail('phải ném');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      const err = e as InvalidTransitionError;
      expect(err.from).toBe('reconciled');
      expect(err.event).toBe('START_TRANSACTION');
      expect(err.message).toContain('reconciled');
    }
  });

  it('failed là trạng thái cuối, reconciled thì không (còn #19)', () => {
    expect(sm.isTerminal('failed')).toBe(true);
    expect(sm.isTerminal('reconciled')).toBe(false);
  });

  it('mọi cặp (trạng thái, sự kiện) ngoài bảng đều bị từ chối — quét toàn bộ', () => {
    const events: SessionEvent[] = [
      'REMOTE_START_ACCEPTED',
      'START_TRANSACTION',
      'START_TIMEOUT',
      'STATUS_SUSPENDED',
      'STATUS_CHARGING',
      'STOP_REQUESTED',
      'REMOTE_STOP_REJECTED',
      'STOP_TRANSACTION',
      'RECONCILE_OK',
      'RECONCILE_CONFLICT',
      'STATION_OFFLINE',
      'HARD_CAP_EXCEEDED',
      'OPERATOR_RESOLVED',
      'LIVE_MESSAGE',
      'LATE_SAMPLE_CONFLICT',
    ];
    const froms: (SessionStatus | null)[] = [INITIAL, ...SESSION_STATUSES];
    let valid = 0;
    let rejected = 0;
    for (const from of froms) {
      for (const event of events) {
        const inTable = TRANSITIONS.some((t) => t.from === from && t.event === event);
        if (inTable) {
          valid++;
          expect(() => sm.apply(from, event)).not.toThrow();
        } else {
          rejected++;
          expect(() => sm.apply(from, event)).toThrow(InvalidTransitionError);
        }
      }
    }
    expect(valid).toBe(TRANSITIONS.length);
    expect(rejected).toBe(froms.length * events.length - TRANSITIONS.length);
  });
});
