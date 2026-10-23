/**
 * Unit test tiện ích frame OCPP-J: lấy đồng hồ trụ trong payload và parse frame thô.
 */
import { cpTimestampOf, parseFrame } from './ocpp-types.js';

describe('cpTimestampOf', () => {
  it('StartTransaction / StopTransaction: trường timestamp ở gốc', () => {
    expect(
      cpTimestampOf('StopTransaction', { timestamp: '2026-09-16T14:18:52.934Z', meterStop: 242 }),
    ).toEqual(new Date('2026-09-16T14:18:52.934Z'));
  });

  it('MeterValues: timestamp của meterValue[0]', () => {
    expect(
      cpTimestampOf('MeterValues', {
        connectorId: 1,
        transactionId: 3,
        meterValue: [
          { timestamp: '2026-09-16T14:18:57.815Z', sampledValue: [{ value: '303.03' }] },
        ],
      }),
    ).toEqual(new Date('2026-09-16T14:18:57.815Z'));
  });

  it('Heartbeat / StatusNotification không có timestamp → null', () => {
    expect(cpTimestampOf('Heartbeat', {})).toBeNull();
    expect(
      cpTimestampOf('StatusNotification', {
        connectorId: 1,
        status: 'Available',
        errorCode: 'NoError',
      }),
    ).toBeNull();
    expect(cpTimestampOf('MeterValues', { meterValue: [] })).toBeNull();
    expect(cpTimestampOf('X', null)).toBeNull();
  });

  it('timestamp hỏng → null thay vì Invalid Date', () => {
    expect(cpTimestampOf('StopTransaction', { timestamp: 'hom-qua' })).toBeNull();
  });
});

describe('parseFrame', () => {
  it('CALL', () => {
    expect(parseFrame('[2,"abc","Heartbeat",{}]')).toEqual({
      messageType: 2,
      uniqueId: 'abc',
      action: 'Heartbeat',
      raw: [2, 'abc', 'Heartbeat', {}],
    });
  });

  it('CALLRESULT và CALLERROR không có action', () => {
    expect(parseFrame('[3,"abc",{}]')?.action).toBeNull();
    expect(parseFrame('[4,"abc","NotImplemented","x",{}]')?.messageType).toBe(4);
  });

  it('frame hỏng → null', () => {
    expect(parseFrame('không phải json')).toBeNull();
    expect(parseFrame('{"a":1}')).toBeNull();
    expect(parseFrame('[9,"abc"]')).toBeNull();
    expect(parseFrame('[2,123,"Heartbeat",{}]')).toBeNull();
  });
});
