/**
 * Spec cho các mapper thuần của bảng điều khiển (không DB): dòng DB → JSON phản hồi.
 * Trọng tâm: không bịa số (null thì giữ null), suy "conflict" đúng quy ước ReconciliationService,
 * và cờ replayed dùng đúng ReplayDetector.
 */
import { ReplayDetector } from '../reconciliation/replay-detector.js';
import {
  buildSummary,
  epochOpenedAtFor,
  mapMessage,
  mapMeterValue,
  mapReconciliation,
  mapSession,
  mapStation,
  reconciliationKind,
  replayedFlag,
  resolutionNumber,
} from './console.mappers.js';

const detector = new ReplayDetector(5);
const T = (s: string) => new Date(`2026-09-16T${s}Z`);

describe('mapStation', () => {
  it('sắp súng theo connector_no, đổi ngày sang ISO và giữ null', () => {
    const out = mapStation(
      {
        serialNumber: 'RH24D1-00001',
        lifecycle: 'in_service',
        currentEpoch: 2,
        lastMessageAt: T('14:20:58.209'),
        connectors: [
          { connectorNo: 2, status: 'Charging', statusChangedAt: null },
          { connectorNo: 1, status: 'Available', statusChangedAt: T('14:00:00') },
        ],
      },
      true,
    );
    expect(out.serial).toBe('RH24D1-00001');
    expect(out.connected).toBe(true);
    expect(out.last_message_at).toBe('2026-09-16T14:20:58.209Z');
    expect(out.connectors.map((c) => c.connector_no)).toEqual([1, 2]);
    expect(out.connectors[1]?.status_changed_at).toBeNull();
  });

  it('trụ chưa từng nhắn: last_message_at = null', () => {
    const out = mapStation(
      {
        serialNumber: 'X',
        lifecycle: 'registered',
        currentEpoch: 0,
        lastMessageAt: null,
        connectors: [],
      },
      false,
    );
    expect(out.last_message_at).toBeNull();
    expect(out.connected).toBe(false);
  });
});

describe('reconciliationKind / resolutionNumber / mapReconciliation', () => {
  const conflict =
    'conflict: meter_stop_minus_start=242 series_last=1042.64 diff=801 samples=13 monotonic=true gaps=1 trigger=stop replayed=true';

  it('DỮ LIỆU CŨ trước 0001: meter_gap + resolution "conflict…" → conflict; "gap_detected…" → gap_detected', () => {
    expect(reconciliationKind('meter_gap', conflict)).toBe('conflict');
    expect(reconciliationKind('meter_gap', 'conflict (late_sample): x=1')).toBe('conflict');
    expect(reconciliationKind('meter_gap', 'gap_detected: x=1')).toBe('gap_detected');
    expect(reconciliationKind('meter_gap', null)).toBe('meter_gap');
    expect(reconciliationKind('replay', 'replay: action=StopTransaction')).toBe('replay');
    expect(reconciliationKind('unknown_id_tag', null)).toBe('unknown_id_tag');
  });

  it('dạng mới từ 0001: record_type conflict / late_sample tự mang ý nghĩa', () => {
    expect(reconciliationKind('conflict', conflict)).toBe('conflict');
    expect(reconciliationKind('conflict', null)).toBe('conflict');
    // late_sample: kết luận đọc từ tiền tố resolution
    expect(reconciliationKind('late_sample', 'conflict (late_sample): diff=801')).toBe('conflict');
    expect(reconciliationKind('late_sample', 'gap_detected (late_sample): diff=0')).toBe(
      'gap_detected',
    );
    expect(reconciliationKind('late_sample', null)).toBe('late_sample');
  });

  it('mapReconciliation đọc cả bản ghi mới (late_sample) lẫn bản ghi cũ (meter_gap + "(late_sample)")', () => {
    const base = {
      id: 1,
      sessionId: 3,
      transactionNo: 3,
      recordNo: 2,
      gapStart: null,
      gapEnd: null,
      energyDifferenceWh: 801,
      reviewedAt: null,
      createdAt: T('14:21:00'),
    };
    const resolution = conflict.replace('conflict:', 'conflict (late_sample):');
    const fresh = mapReconciliation({ ...base, recordType: 'late_sample', resolution });
    const legacy = mapReconciliation({ ...base, recordType: 'meter_gap', resolution });
    for (const out of [fresh, legacy]) {
      expect(out.kind).toBe('conflict');
      expect(out.late_sample).toBe(true);
      expect(out.series_last_wh).toBe(1042.64);
    }
    expect(fresh.record_type).toBe('late_sample');
    expect(legacy.record_type).toBe('meter_gap');
    // late_sample không kèm "(late_sample)" trong resolution vẫn là mẫu muộn
    expect(
      mapReconciliation({ ...base, recordType: 'late_sample', resolution: 'conflict: x=1' })
        .late_sample,
    ).toBe(true);
  });

  it('rút số từ resolution; "null" hoặc thiếu khoá → null, không nhầm khoá có tiền tố', () => {
    expect(resolutionNumber(conflict, 'meter_stop_minus_start')).toBe(242);
    expect(resolutionNumber(conflict, 'series_last')).toBe(1042.64);
    expect(resolutionNumber(conflict, 'diff')).toBe(801);
    expect(resolutionNumber('conflict: series_last=null', 'series_last')).toBeNull();
    expect(resolutionNumber(conflict, 'last')).toBeNull();
    expect(resolutionNumber(null, 'diff')).toBeNull();
  });

  it('mapReconciliation: giữ energy_difference_wh, đánh dấu late_sample và reviewed', () => {
    const out = mapReconciliation({
      id: 9,
      sessionId: 3,
      transactionNo: 3,
      recordNo: 7,
      recordType: 'meter_gap',
      gapStart: T('14:19:47.867'),
      gapEnd: T('14:20:27.901'),
      energyDifferenceWh: 801,
      reviewedAt: null,
      resolution: conflict.replace('conflict:', 'conflict (late_sample):'),
      createdAt: T('14:21:00'),
    });
    expect(out.kind).toBe('conflict');
    expect(out.late_sample).toBe(true);
    expect(out.reviewed).toBe(false);
    expect(out.energy_difference_wh).toBe(801);
    expect(out.meter_stop_minus_start_wh).toBe(242);
    expect(out.series_last_wh).toBe(1042.64);
    expect(out.gap_start).toBe('2026-09-16T14:19:47.867Z');
  });

  it('bản ghi không có resolution: số rút ra là null chứ không phải 0', () => {
    const out = mapReconciliation({
      id: 1,
      sessionId: 1,
      transactionNo: null,
      recordNo: 1,
      recordType: 'duplicate',
      gapStart: null,
      gapEnd: null,
      energyDifferenceWh: null,
      reviewedAt: T('15:00:00'),
      resolution: null,
      createdAt: T('14:00:00'),
    });
    expect(out.meter_stop_minus_start_wh).toBeNull();
    expect(out.series_last_wh).toBeNull();
    expect(out.reviewed).toBe(true);
  });
});

describe('mapSession', () => {
  const base = {
    id: 3,
    transactionNo: 3,
    serialNumber: 'RH24D1-00001',
    connectorNo: 2,
    idTag: 'BB2TBR09',
    origin: 'rfid',
    paymentMode: 'free',
    status: 'review',
    receivedStartedAt: T('14:18:00'),
    receivedStoppedAt: null,
    cpStartedAt: T('14:17:59'),
    cpStoppedAt: null,
    meterStartWh: 0,
    meterStopWh: null,
    stopReason: null,
    deliveredOffline: false,
    energyWh: null,
  };

  it('phiên chưa đóng: energy_wh và meter_stop_wh giữ null, latest_meter_wh tách riêng', () => {
    const out = mapSession(base, { meterValueCount: 13, hasConflict: true, latestMeterWh: 796.5 });
    expect(out.energy_wh).toBeNull();
    expect(out.meter_stop_wh).toBeNull();
    expect(out.latest_meter_wh).toBe(796.5);
    expect(out.ended_at).toBeNull();
    expect(out.station).toBe('RH24D1-00001');
    expect(out.has_conflict).toBe(true);
    expect(out.meter_value_count).toBe(13);
  });

  it('started_at lấy theo đồng hồ CSMS, đồng hồ trụ trả riêng', () => {
    const out = mapSession(base, { meterValueCount: 0, hasConflict: false, latestMeterWh: null });
    expect(out.started_at).toBe('2026-09-16T14:18:00.000Z');
    expect(out.cp_started_at).toBe('2026-09-16T14:17:59.000Z');
  });
});

describe('replay: replayedFlag / epochOpenedAtFor / mapMessage / mapMeterValue', () => {
  const opened = T('14:20:22.978');

  it('cp_timestamp trước epoch → true; sau epoch và skew nhỏ → false', () => {
    expect(replayedFlag(detector, T('14:18:52.934'), T('14:20:58.209'), opened)).toBe(true);
    expect(replayedFlag(detector, T('14:20:30.000'), T('14:20:30.002'), opened)).toBe(false);
  });

  it('thiếu cp_timestamp hoặc thiếu mốc epoch → null (không bịa)', () => {
    expect(replayedFlag(detector, null, T('14:20:30'), opened)).toBeNull();
    expect(replayedFlag(detector, T('14:20:30'), T('14:20:30'), null)).toBeNull();
  });

  it('epochOpenedAtFor chọn kết nối mở gần nhất không muộn hơn thời điểm hỏi', () => {
    const conns = [{ openedAt: T('14:10:00') }, { openedAt: opened }];
    expect(epochOpenedAtFor(conns, T('14:19:00'))).toEqual(T('14:10:00'));
    expect(epochOpenedAtFor(conns, T('14:21:00'))).toEqual(opened);
    expect(epochOpenedAtFor(conns, T('14:00:00'))).toBeNull();
  });

  it('mapMessage: CALL có cp_timestamp trước epoch → replayed; frame out không timestamp → null', () => {
    const call = mapMessage(
      {
        id: 10,
        serialNumber: 'S',
        receivedAt: T('14:20:58.209'),
        cpTimestamp: T('14:18:52.934'),
        epoch: 2,
        direction: 'in',
        messageType: 2,
        action: 'StopTransaction',
        uniqueId: 'abc',
        epochOpenedAt: opened,
      },
      detector,
    );
    expect(call.replayed).toBe(true);
    const out = mapMessage(
      {
        id: 11,
        serialNumber: 'S',
        receivedAt: T('14:20:58.3'),
        cpTimestamp: null,
        epoch: 2,
        direction: 'out',
        messageType: 3,
        action: null,
        uniqueId: 'abc',
        epochOpenedAt: opened,
      },
      detector,
    );
    expect(out.replayed).toBeNull();
    expect(out.action).toBeNull();
  });

  it('mapMeterValue đổi numeric dạng chuỗi sang số và gắn replayed theo epoch hiện hành', () => {
    const out = mapMeterValue(
      {
        id: 1,
        cpTimestamp: T('14:19:47.867'),
        receivedAt: T('14:20:40'),
        measurand: 'Energy.Active.Import.Register',
        value: '1042.640',
        unit: 'Wh',
        context: null,
        phase: null,
      },
      detector,
      [{ openedAt: T('14:10:00') }, { openedAt: opened }],
    );
    expect(out.value).toBe(1042.64);
    expect(out.replayed).toBe(true);
  });
});

describe('buildSummary', () => {
  it('đủ 9 trạng thái phiên và 7 loại đối soát (điền 0), online/offline tính từ registry', () => {
    const out = buildSummary({
      stationSerials: ['A', 'B', 'C'],
      connectedSerials: new Set(['A', 'Z']),
      sessionCounts: new Map([
        ['review', 1],
        ['reconciled', 2],
      ]),
      recordCounts: new Map([['meter_gap', 7]]),
      conflictCount: 7,
      frameCount: 150,
    });
    expect(out.stations).toEqual({ total: 3, online: 1, offline: 2 });
    expect(Object.keys(out.sessions_by_status)).toHaveLength(9);
    expect(out.sessions_by_status['review']).toBe(1);
    expect(out.sessions_by_status['failed']).toBe(0);
    expect(out.sessions_total).toBe(3);
    expect(Object.keys(out.reconciliation_by_type)).toHaveLength(7);
    expect(out.reconciliation_by_type['conflict']).toBe(0);
    expect(out.reconciliation_by_type['late_sample']).toBe(0);
    expect(out.reconciliation_conflicts).toBe(7);
    expect(out.message_frames).toBe(150);
  });
});
