/**
 * Test adapter SteVe bằng dữ liệu GIẢ (hàm `query` giả) — SteVe thật chưa chạy được trên máy dev.
 * Kiểm: SQL đăng ký, ánh xạ giao dịch → phiên chuẩn hoá, và chuỗi phân loại NFR-02 đi sau nó.
 */
import { classifyRun } from '../metrics.mjs';
import { createPowermeAdapter, powermeOutcome } from './powerme.mjs';
import { createSteveAdapter, parseBatchOutput, parseWh, registrationSql } from './steve.mjs';

const run = { chargePoint: 'RQ1-B1-V-S2-01', idTag: 'TB1VS201' };

/** `query` giả: trả dữ liệu theo bảng xuất hiện trong câu SQL, ghi lại mọi câu đã nhận. */
function fakeQuery(transactions, failed = 0) {
  const seen = [];
  const query = async (sql) => {
    seen.push(sql);
    if (/FROM `transaction`/.test(sql)) return transactions;
    if (/transaction_stop_failed/.test(sql)) return [{ n: String(failed) }];
    return [];
  };
  return { query, seen };
}

describe('adapter SteVe', () => {
  it('đăng ký trụ và thẻ bằng INSERT IGNORE, từ chối định danh có ký tự lạ', () => {
    const sql = registrationSql([run]);
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('INSERT IGNORE INTO charge_box (charge_box_id, registration_status)');
    expect(sql[0]).toContain("('RQ1-B1-V-S2-01', 'Accepted')");
    expect(sql[1]).toContain("('TB1VS201', 1)");
    expect(() => registrationSql([{ chargePoint: "x'; DROP TABLE y", idTag: 'A' }])).toThrow();
  });

  it('giao dịch đã dừng → billed, E_bill = stop_value − start_value (cột varchar)', async () => {
    const { query, seen } = fakeQuery([
      {
        transaction_pk: '7',
        start_value: '120500',
        stop_value: '120742',
        stop_rows: '1',
        energy_samples: '9',
      },
    ]);
    const adapter = createSteveAdapter({
      query,
      endpoint: 'ws://x/steve/websocket/CentralSystemService',
    });
    const out = await adapter.collect(run);
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({
      sessionId: '7',
      transactionId: 7,
      status: 'stopped',
      outcome: 'billed',
      eBillWh: 242,
      energySamples: 9,
    });
    expect(adapter.isSettled(out)).toBe(true);
    expect(seen[0]).toContain('JOIN evse e ON e.evse_pk = t.evse_pk');
    expect(seen[0]).toContain("e.charge_box_id = 'RQ1-B1-V-S2-01'");

    // meterStop cũ (242) trong khi trụ thật sự đã cấp 1043 Wh → SteVe tính tiền sai im lặng.
    const cls = classifyRun({
      eTrue: 1043,
      eStop: 242,
      sessions: out.sessions.map((s) => ({ outcome: s.outcome, eBill: s.eBillWh })),
    });
    expect(cls.class).toBe('billed_wrong_silent');
  });

  it('giao dịch chưa có stop → open; không có giao dịch → mất; hai giao dịch → trùng', async () => {
    const open = await createSteveAdapter({
      query: fakeQuery([
        {
          transaction_pk: '8',
          start_value: '10',
          stop_value: null,
          stop_rows: '0',
          energy_samples: '2',
        },
      ]).query,
      endpoint: 'ws://x',
    }).collect(run);
    expect(open.sessions[0]).toMatchObject({ status: 'active', outcome: 'open', eBillWh: null });

    const none = await createSteveAdapter({
      query: fakeQuery([]).query,
      endpoint: 'ws://x',
    }).collect(run);
    expect(classifyRun({ eTrue: 5, eStop: 5, sessions: none.sessions }).subtype).toBe('lost');

    const two = await createSteveAdapter({
      query: fakeQuery([
        {
          transaction_pk: '1',
          start_value: '0',
          stop_value: '5',
          stop_rows: '1',
          energy_samples: '0',
        },
        {
          transaction_pk: '2',
          start_value: '0',
          stop_value: '5',
          stop_rows: '1',
          energy_samples: '0',
        },
      ]).query,
      endpoint: 'ws://x',
    }).collect(run);
    expect(classifyRun({ eTrue: 5, eStop: 5, sessions: two.sessions }).subtype).toBe('duplicate');
  });

  it('StopTransaction gửi lại để lại nhiều dòng transaction_stop; đếm dòng stop_failed', async () => {
    const { query } = fakeQuery(
      [
        {
          transaction_pk: '3',
          start_value: '0',
          stop_value: '50',
          stop_rows: '2',
          energy_samples: '4',
        },
      ],
      1,
    );
    const out = await createSteveAdapter({ query, endpoint: 'ws://x' }).collect(run);
    expect(out.sessions[0].records).toEqual({ duplicate_stop_rows: 1 });
    expect(out.extra.stopFailedRows).toBe(1);
  });

  it('schema cũ dùng bảng connector', async () => {
    const { query, seen } = fakeQuery([]);
    await createSteveAdapter({ query, endpoint: 'ws://x', schema: 'connector' }).collect(run);
    expect(seen[0]).toContain('JOIN connector e ON e.connector_pk = t.connector_pk');
  });

  it('parseWh và parseBatchOutput', () => {
    expect(parseWh('120742')).toBe(120742);
    expect(parseWh('48.46')).toBe(48);
    expect(parseWh(null)).toBeNull();
    expect(parseWh('abc')).toBeNull();
    expect(parseBatchOutput('transaction_pk\tstop_value\n7\tNULL\n8\t15\n')).toEqual([
      { transaction_pk: '7', stop_value: null },
      { transaction_pk: '8', stop_value: '15' },
    ]);
    expect(parseBatchOutput('')).toEqual([]);
  });
});

describe('adapter PowerMe (dữ liệu giả)', () => {
  it('ánh xạ trạng thái phiên → outcome', () => {
    expect(powermeOutcome({ status: 'reconciled', energy_wh: '242' })).toBe('billed');
    expect(powermeOutcome({ status: 'reconciled', energy_wh: null })).toBe('open');
    expect(powermeOutcome({ status: 'review', energy_wh: '242' })).toBe('held');
    expect(powermeOutcome({ status: 'orphaned', energy_wh: null })).toBe('open');
  });

  it('phiên review không có E_bill dù energy_wh có số', async () => {
    const db = {
      async query(sql) {
        if (/FROM sessions s/.test(sql)) {
          return {
            rows: [
              {
                id: '12',
                transaction_no: 40,
                status: 'review',
                payment_mode: 'csms_billed',
                meter_start_wh: '100',
                meter_stop_wh: '342',
                energy_wh: '242',
                delivered_offline: true,
              },
            ],
          };
        }
        if (/reconciliation_records/.test(sql)) return { rows: [{ t: 'late_sample', n: 1 }] };
        if (/credit_transactions/.test(sql)) return { rows: [{ vnd: '0', n: 0 }] };
        return { rows: [{ path: 'x' }] };
      },
    };
    const out = await createPowermeAdapter({ db, endpoint: 'ws://x/ocpp' }).collect(run);
    expect(out.sessions[0]).toMatchObject({
      sessionId: '12',
      transactionId: 40,
      outcome: 'held',
      eBillWh: null,
      meterStopWh: 342,
      records: { late_sample: 1 },
      debitVnd: null,
    });
  });
});
