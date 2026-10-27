/**
 * Dữ liệu mô phỏng ban đầu. Mỗi dòng được chọn để đi qua một nhánh của sơ đồ:
 *   - sự cố: GroundFailure (critical, Reset vẫn lỗi → hết hạn), InternalError (Reset hồi phục),
 *     ConnectorLockFailure (trụ từ chối Reset), lỗi cả trụ (connector 0), một sự cố đã đóng;
 *   - billing: top-up hoàn được / không đủ số dư / đã hoàn, thanh toán trễ (có dòng cổng lỗi),
 *     hoá đơn needs_review (một dòng retry thành công, một dòng lỗi tiếp), tài khoản đã đóng.
 * Thời gian tính tương đối theo lúc tạo để giao diện luôn "mới".
 */
import type {
  ClosedAccountRefund,
  DeviceRecord,
  FaultEvent,
  FreeVendTag,
  LatePayment,
  MaintenanceTicket,
  NeedsReviewInvoice,
  Pillar,
  PillarRevenue,
  Promotion,
  RefundableTopUp,
  RemoteCommand,
  ReviewSession,
  RfidCard,
  SessionUser,
  Site,
  StartIntent,
  TariffPeriod,
  UserAccount,
} from '../types/domain';

/** Hành vi giả lập của trụ khi nhận Reset (do test/mock quyết, không có trong dữ liệu thật). */
export type ResetBehaviour = 'recovers' | 'still_faulted' | 'rejected';

export interface MockFault extends FaultEvent {
  resetBehaviour: ResetBehaviour;
}

export interface MockTopUp extends RefundableTopUp {
  status: 'credited' | 'refunded';
}

export interface MockLatePayment extends LatePayment {
  refunded: boolean;
  gatewayFails: boolean;
}

export interface MockInvoice extends NeedsReviewInvoice {
  status: 'needs_review' | 'issued';
  invoiceNo: string | null;
  /** Lần retry kế tiếp có thành công không (giả lập nhà cung cấp hoá đơn). */
  nextRetrySucceeds: boolean;
}

export interface MockClosedAccount extends ClosedAccountRefund {
  refunded: boolean;
}

export interface MockDb {
  users: (SessionUser & { password: string })[];
  sites: Site[];
  pillars: Pillar[];
  faults: MockFault[];
  commands: RemoteCommand[];
  sessions: ReviewSession[];
  intents: StartIntent[];
  tariff: TariffPeriod[];
  promotions: Promotion[];
  tickets: MaintenanceTicket[];
  revenue: PillarRevenue[];
  accounts: UserAccount[];
  devices: DeviceRecord[];
  cards: RfidCard[];
  freeVend: FreeVendTag[];
  topUps: MockTopUp[];
  latePayments: MockLatePayment[];
  invoices: MockInvoice[];
  closedAccounts: MockClosedAccount[];
  seq: { fault: number; command: number; pillar: number; device: number };
}

export function createSeed(now: number = Date.now()): MockDb {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const days = (d: number) => new Date(now + d * 86_400_000).toISOString();

  const sites: Site[] = [
    { id: 1, code: 'HCM-Q1', name: 'PowerMe Nguyễn Huệ', address: '12 Nguyễn Huệ, Q.1, TP.HCM' },
    {
      id: 2,
      code: 'HCM-Q7',
      name: 'PowerMe Phú Mỹ Hưng',
      address: '88 Nguyễn Đức Cảnh, Q.7, TP.HCM',
    },
  ];

  const pillars: Pillar[] = [
    {
      id: 1,
      serial: 'RH24D1-00001',
      displayCode: 'Q1-01',
      model: 'D1-120',
      firmware: '3.2.7',
      siteId: 1,
      siteName: sites[0]!.name,
      lifecycle: 'in_service',
      isOnline: true,
      lastSeenAt: ago(0.2),
      connectors: [
        {
          connectorNo: 1,
          status: 'Faulted',
          errorCode: 'GroundFailure',
          statusChangedAt: ago(14),
          activeSession: null,
        },
        {
          connectorNo: 2,
          status: 'Charging',
          errorCode: null,
          statusChangedAt: ago(25),
          activeSession: { transactionNo: 412, energyWh: 18_640, startedAt: ago(25) },
        },
      ],
    },
    {
      id: 2,
      serial: 'RH24D1-00002',
      displayCode: 'Q1-02',
      model: 'D1-120',
      firmware: '3.2.7',
      siteId: 1,
      siteName: sites[0]!.name,
      lifecycle: 'in_service',
      isOnline: true,
      lastSeenAt: ago(0.5),
      connectors: [
        {
          connectorNo: 1,
          status: 'Faulted',
          errorCode: 'InternalError',
          statusChangedAt: ago(6),
          activeSession: null,
        },
        {
          connectorNo: 2,
          status: 'Available',
          errorCode: null,
          statusChangedAt: ago(90),
          activeSession: null,
        },
      ],
    },
    {
      id: 3,
      serial: 'RH24YJ-00003',
      displayCode: 'Q7-01',
      model: 'YJ-EU-60',
      firmware: '2.0.4',
      siteId: 2,
      siteName: sites[1]!.name,
      lifecycle: 'in_service',
      isOnline: true,
      lastSeenAt: ago(1),
      connectors: [
        {
          connectorNo: 1,
          status: 'Faulted',
          errorCode: 'ConnectorLockFailure',
          statusChangedAt: ago(40),
          activeSession: null,
        },
        {
          connectorNo: 2,
          status: 'Preparing',
          errorCode: null,
          statusChangedAt: ago(2),
          activeSession: null,
        },
      ],
    },
    {
      id: 4,
      serial: 'RH24YJ-00004',
      displayCode: 'Q7-02',
      model: 'YJ-EU-60',
      firmware: '2.0.4',
      siteId: 2,
      siteName: sites[1]!.name,
      lifecycle: 'in_service',
      isOnline: false,
      lastSeenAt: ago(22),
      connectors: [
        {
          connectorNo: 1,
          status: 'Unavailable',
          errorCode: 'UnderVoltage',
          statusChangedAt: ago(30),
          activeSession: null,
        },
        {
          connectorNo: 2,
          status: 'Unavailable',
          errorCode: null,
          statusChangedAt: ago(30),
          activeSession: null,
        },
      ],
    },
  ];

  const fault = (
    f: Omit<
      MockFault,
      | 'severity'
      | 'hint'
      | 'resetCommandId'
      | 'resetCommandStatus'
      | 'resetDeadline'
      | 'pillarOnline'
    >,
  ): MockFault => ({
    ...f,
    severity: 'none',
    hint: '',
    resetCommandId: null,
    resetCommandStatus: null,
    resetDeadline: null,
    pillarOnline: true,
  });

  const faults: MockFault[] = [
    fault({
      id: 1,
      eventNo: 101,
      pillarId: 1,
      serial: 'RH24D1-00001',
      siteName: sites[0]!.name,
      connectorNo: 1,
      source: 'ocpp',
      errorCode: 'GroundFailure',
      status: 'raised',
      raisedAt: ago(14),
      acknowledgedAt: null,
      resolvedAt: null,
      driverReports: 2,
      resetBehaviour: 'still_faulted',
    }),
    fault({
      id: 2,
      eventNo: 102,
      pillarId: 2,
      serial: 'RH24D1-00002',
      siteName: sites[0]!.name,
      connectorNo: 1,
      source: 'ocpp',
      errorCode: 'InternalError',
      status: 'acknowledged',
      raisedAt: ago(6),
      acknowledgedAt: ago(4),
      resolvedAt: null,
      driverReports: 0,
      resetBehaviour: 'recovers',
    }),
    fault({
      id: 3,
      eventNo: 103,
      pillarId: 3,
      serial: 'RH24YJ-00003',
      siteName: sites[1]!.name,
      connectorNo: 1,
      source: 'ocpp',
      errorCode: 'ConnectorLockFailure',
      status: 'acknowledged',
      raisedAt: ago(40),
      acknowledgedAt: ago(35),
      resolvedAt: null,
      driverReports: 1,
      resetBehaviour: 'rejected',
    }),
    fault({
      id: 4,
      eventNo: 104,
      pillarId: 4,
      serial: 'RH24YJ-00004',
      siteName: sites[1]!.name,
      connectorNo: 0,
      source: 'ocpp',
      errorCode: 'UnderVoltage',
      status: 'raised',
      raisedAt: ago(30),
      acknowledgedAt: null,
      resolvedAt: null,
      driverReports: 0,
      resetBehaviour: 'still_faulted',
    }),
    fault({
      id: 5,
      eventNo: 99,
      pillarId: 1,
      serial: 'RH24D1-00001',
      siteName: sites[0]!.name,
      connectorNo: 2,
      source: 'ocpp',
      errorCode: 'EVCommunicationError',
      status: 'resolved',
      raisedAt: ago(600),
      acknowledgedAt: null,
      resolvedAt: ago(598),
      driverReports: 0,
      resetBehaviour: 'recovers',
    }),
  ];

  const sessions: ReviewSession[] = [
    {
      id: 1,
      transactionNo: 3,
      serial: 'RH24D1-00001',
      connectorNo: 1,
      idTag: 'BB2TBR09',
      origin: 'rfid',
      paymentMode: 'csms_billed',
      status: 'review',
      queue: 'review',
      reason: 'Đối soát conflict: meterStop 242 Wh, chuỗi MeterValues 1.042 Wh (chênh 801 Wh)',
      meterStopWh: 242,
      seriesLastWh: 1043,
      startedAt: ago(180),
      endedAt: ago(170),
      deliveredOffline: true,
      resolvedNote: null,
    },
    {
      id: 2,
      transactionNo: 7,
      serial: 'RH24YJ-00003',
      connectorNo: 2,
      idTag: 'UNDEFINED',
      origin: 'rfid',
      paymentMode: 'unattributed',
      status: 'closed',
      queue: 'unattributed',
      reason: 'Thẻ lạ — không có trong rfid_cards (ADR-0012)',
      meterStopWh: 6_300,
      seriesLastWh: 6_300,
      startedAt: ago(300),
      endedAt: ago(260),
      deliveredOffline: false,
      resolvedNote: null,
    },
    {
      id: 3,
      transactionNo: 9,
      serial: 'RH24D1-00002',
      connectorNo: 2,
      idTag: 'FREEVEND',
      origin: 'free_vend',
      paymentMode: 'unattributed',
      status: 'closed',
      queue: 'unattributed',
      reason: 'Free vend tại HMI — không có người trả tiền',
      meterStopWh: 2_100,
      seriesLastWh: 2_100,
      startedAt: ago(500),
      endedAt: ago(480),
      deliveredOffline: false,
      resolvedNote: null,
    },
  ];

  const intents: StartIntent[] = [
    {
      id: 1,
      driverEmail: 'son.driver@powerme.local',
      serial: 'RH24D1-00002',
      connectorNo: 2,
      requestedAt: ago(8),
      state: 'stuck',
      lateStartSeen: true,
      note: null,
    },
    {
      id: 2,
      driverEmail: 'lan.nguyen@gmail.com',
      serial: 'RH24YJ-00003',
      connectorNo: 2,
      requestedAt: ago(3),
      state: 'stuck',
      lateStartSeen: false,
      note: null,
    },
  ];

  const tariff: TariffPeriod[] = [
    { band: 'Off-peak', start: '00:00', end: '04:00', pricePerKwhVnd: 2_400 },
    { band: 'Shoulder', start: '04:00', end: '09:30', pricePerKwhVnd: 3_200 },
    { band: 'Peak', start: '09:30', end: '11:30', pricePerKwhVnd: 4_100 },
    { band: 'Shoulder', start: '11:30', end: '17:00', pricePerKwhVnd: 3_200 },
    { band: 'Sharp', start: '17:00', end: '20:00', pricePerKwhVnd: 4_800 },
    { band: 'Shoulder', start: '20:00', end: '22:00', pricePerKwhVnd: 3_200 },
    { band: 'Off-peak', start: '22:00', end: '24:00', pricePerKwhVnd: 2_400 },
  ];

  return {
    users: [
      {
        id: 10,
        email: 'operator@powerme.local',
        password: 'powerme123',
        name: 'Trần Trọng Nghĩa',
        role: 'operator',
        operatorId: 1,
        operatorName: 'SaiGon EV Partners',
      },
      {
        id: 1,
        email: 'admin@powerme.local',
        password: 'powerme123',
        name: 'PowerMe Admin',
        role: 'admin',
        operatorId: null,
        operatorName: null,
      },
    ],
    sites,
    pillars,
    faults,
    commands: [],
    sessions,
    intents,
    tariff,
    promotions: [
      {
        id: 1,
        name: 'Giờ thấp điểm cuối tuần',
        discountPercent: 15,
        validFrom: days(-10),
        validTo: days(20),
        active: true,
      },
      {
        id: 2,
        name: 'Khai trương Phú Mỹ Hưng',
        discountPercent: 30,
        validFrom: days(-40),
        validTo: days(-10),
        active: false,
      },
    ],
    tickets: [
      {
        id: 1,
        ticketNo: 7,
        faultEventNo: 98,
        serial: 'RH24YJ-00003',
        status: 'in_progress',
        assignedTo: 'Kỹ thuật Q7',
        openedAt: ago(1440),
      },
    ],
    revenue: [
      {
        serial: 'RH24D1-00001',
        siteName: sites[0]!.name,
        sessions: 46,
        energyKwh: 1_204,
        revenueVnd: 4_215_000,
        unattributedSessions: 1,
        utilisationPercent: 38,
      },
      {
        serial: 'RH24D1-00002',
        siteName: sites[0]!.name,
        sessions: 39,
        energyKwh: 988,
        revenueVnd: 3_402_000,
        unattributedSessions: 2,
        utilisationPercent: 31,
      },
      {
        serial: 'RH24YJ-00003',
        siteName: sites[1]!.name,
        sessions: 21,
        energyKwh: 402,
        revenueVnd: 1_389_000,
        unattributedSessions: 1,
        utilisationPercent: 17,
      },
      {
        serial: 'RH24YJ-00004',
        siteName: sites[1]!.name,
        sessions: 12,
        energyKwh: 230,
        revenueVnd: 804_000,
        unattributedSessions: 0,
        utilisationPercent: 9,
      },
    ],
    accounts: [
      {
        id: 1,
        email: 'admin@powerme.local',
        name: 'PowerMe Admin',
        role: 'admin',
        operatorName: null,
        status: 'active',
        createdAt: days(-60),
      },
      {
        id: 10,
        email: 'operator@powerme.local',
        name: 'Trần Trọng Nghĩa',
        role: 'operator',
        operatorName: 'SaiGon EV Partners',
        status: 'active',
        createdAt: days(-45),
      },
      {
        id: 11,
        email: 'q7.tech@sgev.vn',
        name: 'Kỹ thuật Q7',
        role: 'operator',
        operatorName: 'SaiGon EV Partners',
        status: 'active',
        createdAt: days(-30),
      },
      {
        id: 20,
        email: 'son.driver@powerme.local',
        name: 'Lý Hoàng Sơn',
        role: 'driver',
        operatorName: null,
        status: 'active',
        createdAt: days(-20),
      },
      {
        id: 21,
        email: 'lan.nguyen@gmail.com',
        name: 'Nguyễn Thị Lan',
        role: 'driver',
        operatorName: null,
        status: 'active',
        createdAt: days(-12),
      },
      {
        id: 22,
        email: 'minh.pham@gmail.com',
        name: 'Phạm Quang Minh',
        role: 'driver',
        operatorName: null,
        status: 'closed',
        createdAt: days(-50),
      },
    ],
    devices: [
      ...pillars.map((p, i) => ({
        id: i + 1,
        serial: p.serial,
        model: p.model,
        firmware: p.firmware,
        lifecycle: p.lifecycle,
        operatorName: 'SaiGon EV Partners',
        registeredAt: days(-50 + i),
        warrantyUntil: days(680 + i),
      })),
      {
        id: 5,
        serial: 'RH24D1-00005',
        model: 'D1-120' as const,
        firmware: '3.2.7',
        lifecycle: 'registered' as const,
        operatorName: null,
        registeredAt: days(-2),
        warrantyUntil: days(728),
      },
      {
        id: 6,
        serial: 'RH24YJ-00006',
        model: 'YJ-EU-60' as const,
        firmware: '2.0.4',
        lifecycle: 'registered' as const,
        operatorName: null,
        registeredAt: days(-1),
        warrantyUntil: days(729),
      },
    ],
    cards: [
      { id: 1, uid: '04A2B9C1', type: 'online', holder: 'Lý Hoàng Sơn', status: 'active' },
      { id: 2, uid: '04F00D77', type: 'wallet', holder: null, status: 'active' },
      { id: 3, uid: 'BB2TBR09', type: 'online', holder: 'Nguyễn Thị Lan', status: 'active' },
      { id: 4, uid: '04DEAD00', type: 'online', holder: 'Phạm Quang Minh', status: 'blocked' },
    ],
    freeVend: pillars.map((p) => ({ serial: p.serial, tag: 'FREEVEND' })),
    topUps: [
      {
        id: 501,
        driverName: 'Nguyễn Thị Lan',
        gatewayRef: 'PM20261027-0501',
        amountVnd: 200_000,
        amountPaidVnd: 195_000,
        pointsRedeemed: 500,
        completedAt: ago(120),
        balanceVnd: 230_000,
        refundable: true,
        status: 'credited',
      },
      {
        id: 502,
        driverName: 'Lý Hoàng Sơn',
        gatewayRef: 'PM20261026-0502',
        amountVnd: 300_000,
        amountPaidVnd: 300_000,
        pointsRedeemed: 0,
        completedAt: ago(1500),
        balanceVnd: 120_000,
        refundable: false,
        status: 'credited',
      },
      {
        id: 503,
        driverName: 'Phạm Quang Minh',
        gatewayRef: 'PM20261025-0503',
        amountVnd: 100_000,
        amountPaidVnd: 100_000,
        pointsRedeemed: 0,
        completedAt: ago(3000),
        balanceVnd: 100_000,
        refundable: true,
        status: 'credited',
      },
    ],
    latePayments: [
      {
        id: 601,
        driverName: 'Nguyễn Thị Lan',
        lateGatewayRef: 'VNP14590021',
        lateAmountVnd: 150_000,
        latePaidAt: ago(95),
        expiresAt: ago(185),
        refunded: false,
        gatewayFails: false,
      },
      {
        id: 602,
        driverName: 'Lý Hoàng Sơn',
        lateGatewayRef: 'VNP14590388',
        lateAmountVnd: 500_000,
        latePaidAt: ago(40),
        expiresAt: ago(130),
        refunded: false,
        gatewayFails: true,
      },
    ],
    invoices: [
      {
        id: 701,
        topUpId: 488,
        driverName: 'Lý Hoàng Sơn',
        amountVnd: 300_000,
        attemptCount: 3,
        lastErrorKind: 'temporary',
        lastErrorMessage: 'Provider timeout sau 30 s (lần 3/3)',
        updatedAt: ago(50),
        status: 'needs_review',
        invoiceNo: null,
        nextRetrySucceeds: true,
      },
      {
        id: 702,
        topUpId: 491,
        driverName: 'Nguyễn Thị Lan',
        amountVnd: 195_000,
        attemptCount: 1,
        lastErrorKind: 'rejected',
        lastErrorMessage: 'MST người bán chưa được cấu hình (E_SELLER_TAX_CODE)',
        updatedAt: ago(20),
        status: 'needs_review',
        invoiceNo: null,
        nextRetrySucceeds: false,
      },
    ],
    closedAccounts: [
      {
        id: 22,
        driverName: 'Phạm Quang Minh',
        closedAt: ago(200),
        unusedBalanceVnd: 140_000,
        sources: [
          { topUpId: 503, gatewayRef: 'PM20261025-0503', amountVnd: 100_000 },
          { topUpId: 470, gatewayRef: 'PM20261019-0470', amountVnd: 40_000 },
        ],
        refunded: false,
      },
    ],
    seq: { fault: 105, command: 1, pillar: 5, device: 7 },
  };
}
