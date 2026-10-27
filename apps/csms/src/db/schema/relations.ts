/**
 * `relations()` của Drizzle cho các FK chính — phục vụ relational query API
 * (`db.query.sessions.findMany({ with: { meterValues: true } })`).
 * Gom một file để tránh import vòng giữa các file bảng.
 */
import { relations } from 'drizzle-orm';
import {
  creditAccounts,
  creditTransactions,
  eInvoices,
  invoiceAdjustments,
  loyaltyAccounts,
  loyaltyTransactions,
  topUps,
} from './billing.js';
import { ocppMessageLog, remoteCommands } from './ocpp-log.js';
import {
  faultEvents,
  faultReports,
  maintenanceTickets,
  policyTemplates,
  reservations,
} from './ops.js';
import { reconciliationRecords } from './reconciliation.js';
import {
  meterValues,
  rfidCards,
  sessionPauses,
  sessionStatusHistory,
  sessions,
  vehicleModels,
  vehicles,
} from './sessions.js';
import {
  chargePointConnections,
  chargePoints,
  connectorStatusEvents,
  connectors,
  operators,
  sites,
} from './stations.js';
import { promotions, sessionTariffSegments, tariffPeriods } from './tariffs.js';
import { drivers, operatorStaff, users } from './users.js';

// ---- users ----
export const usersRelations = relations(users, ({ one, many }) => ({
  driver: one(drivers, { fields: [users.id], references: [drivers.userId] }),
  operatorStaff: one(operatorStaff, { fields: [users.id], references: [operatorStaff.userId] }),
  policyTemplates: many(policyTemplates),
  reviewedReconciliations: many(reconciliationRecords),
}));

export const driversRelations = relations(drivers, ({ one, many }) => ({
  user: one(users, { fields: [drivers.userId], references: [users.id] }),
  vehicles: many(vehicles),
  rfidCards: many(rfidCards),
  sessions: many(sessions),
  creditAccount: one(creditAccounts, {
    fields: [drivers.userId],
    references: [creditAccounts.driverId],
  }),
  loyaltyAccount: one(loyaltyAccounts, {
    fields: [drivers.userId],
    references: [loyaltyAccounts.driverId],
  }),
  faultReports: many(faultReports),
  reservations: many(reservations),
}));

export const operatorStaffRelations = relations(operatorStaff, ({ one, many }) => ({
  user: one(users, { fields: [operatorStaff.userId], references: [users.id] }),
  operator: one(operators, { fields: [operatorStaff.operatorId], references: [operators.id] }),
  acknowledgedFaults: many(faultEvents),
  assignedTickets: many(maintenanceTickets),
}));

// ---- stations ----
export const operatorsRelations = relations(operators, ({ many }) => ({
  staff: many(operatorStaff),
  sites: many(sites),
  tariffPeriods: many(tariffPeriods),
  promotions: many(promotions),
}));

export const sitesRelations = relations(sites, ({ one, many }) => ({
  operator: one(operators, { fields: [sites.operatorId], references: [operators.id] }),
  chargePoints: many(chargePoints),
}));

export const chargePointsRelations = relations(chargePoints, ({ one, many }) => ({
  site: one(sites, { fields: [chargePoints.siteId], references: [sites.id] }),
  connectors: many(connectors),
  connections: many(chargePointConnections),
  statusEvents: many(connectorStatusEvents),
  sessions: many(sessions),
  faultEvents: many(faultEvents),
  messageLog: many(ocppMessageLog),
}));

export const connectorsRelations = relations(connectors, ({ one, many }) => ({
  chargePoint: one(chargePoints, {
    fields: [connectors.chargePointId],
    references: [chargePoints.id],
  }),
  statusEvents: many(connectorStatusEvents),
  sessions: many(sessions),
  faultEvents: many(faultEvents),
  faultReports: many(faultReports),
  reservations: many(reservations),
}));

export const connectorStatusEventsRelations = relations(connectorStatusEvents, ({ one }) => ({
  chargePoint: one(chargePoints, {
    fields: [connectorStatusEvents.chargePointId],
    references: [chargePoints.id],
  }),
  connector: one(connectors, {
    fields: [connectorStatusEvents.connectorId],
    references: [connectors.id],
  }),
}));

export const chargePointConnectionsRelations = relations(chargePointConnections, ({ one }) => ({
  chargePoint: one(chargePoints, {
    fields: [chargePointConnections.chargePointId],
    references: [chargePoints.id],
  }),
}));

// ---- sessions ----
export const rfidCardsRelations = relations(rfidCards, ({ one, many }) => ({
  driver: one(drivers, { fields: [rfidCards.driverId], references: [drivers.userId] }),
  sessions: many(sessions),
}));

export const vehicleModelsRelations = relations(vehicleModels, ({ many }) => ({
  vehicles: many(vehicles),
}));

export const vehiclesRelations = relations(vehicles, ({ one, many }) => ({
  driver: one(drivers, { fields: [vehicles.driverId], references: [drivers.userId] }),
  model: one(vehicleModels, { fields: [vehicles.vehicleModelId], references: [vehicleModels.id] }),
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  connector: one(connectors, { fields: [sessions.connectorId], references: [connectors.id] }),
  chargePoint: one(chargePoints, {
    fields: [sessions.chargePointId],
    references: [chargePoints.id],
  }),
  driver: one(drivers, { fields: [sessions.driverId], references: [drivers.userId] }),
  vehicle: one(vehicles, { fields: [sessions.vehicleId], references: [vehicles.id] }),
  rfidCard: one(rfidCards, { fields: [sessions.rfidCardId], references: [rfidCards.id] }),
  promotion: one(promotions, { fields: [sessions.promotionId], references: [promotions.id] }),
  pauses: many(sessionPauses),
  statusHistory: many(sessionStatusHistory),
  meterValues: many(meterValues),
  tariffSegments: many(sessionTariffSegments),
  reconciliationRecords: many(reconciliationRecords),
  creditTransactions: many(creditTransactions),
  loyaltyTransactions: many(loyaltyTransactions),
}));

export const sessionPausesRelations = relations(sessionPauses, ({ one }) => ({
  session: one(sessions, { fields: [sessionPauses.sessionId], references: [sessions.id] }),
}));

export const sessionStatusHistoryRelations = relations(sessionStatusHistory, ({ one }) => ({
  session: one(sessions, {
    fields: [sessionStatusHistory.sessionId],
    references: [sessions.id],
  }),
}));

export const meterValuesRelations = relations(meterValues, ({ one }) => ({
  session: one(sessions, { fields: [meterValues.sessionId], references: [sessions.id] }),
}));

// ---- tariffs ----
export const tariffPeriodsRelations = relations(tariffPeriods, ({ one, many }) => ({
  operator: one(operators, { fields: [tariffPeriods.operatorId], references: [operators.id] }),
  segments: many(sessionTariffSegments),
}));

export const promotionsRelations = relations(promotions, ({ one, many }) => ({
  operator: one(operators, { fields: [promotions.operatorId], references: [operators.id] }),
  sessions: many(sessions),
}));

export const sessionTariffSegmentsRelations = relations(sessionTariffSegments, ({ one }) => ({
  session: one(sessions, { fields: [sessionTariffSegments.sessionId], references: [sessions.id] }),
  tariffPeriod: one(tariffPeriods, {
    fields: [sessionTariffSegments.tariffPeriodId],
    references: [tariffPeriods.id],
  }),
}));

// ---- reconciliation ----
export const reconciliationRecordsRelations = relations(reconciliationRecords, ({ one }) => ({
  session: one(sessions, { fields: [reconciliationRecords.sessionId], references: [sessions.id] }),
  reviewer: one(users, { fields: [reconciliationRecords.reviewedBy], references: [users.id] }),
}));

// ---- billing ----
export const creditAccountsRelations = relations(creditAccounts, ({ one, many }) => ({
  driver: one(drivers, { fields: [creditAccounts.driverId], references: [drivers.userId] }),
  transactions: many(creditTransactions),
  topUps: many(topUps),
}));

export const creditTransactionsRelations = relations(creditTransactions, ({ one }) => ({
  account: one(creditAccounts, {
    fields: [creditTransactions.creditAccountId],
    references: [creditAccounts.id],
  }),
  session: one(sessions, { fields: [creditTransactions.sessionId], references: [sessions.id] }),
  topUp: one(topUps, { fields: [creditTransactions.topUpId], references: [topUps.id] }),
}));

export const topUpsRelations = relations(topUps, ({ one, many }) => ({
  account: one(creditAccounts, {
    fields: [topUps.creditAccountId],
    references: [creditAccounts.id],
  }),
  // Từ migration 0003: tối đa một dòng `top_up` và một dòng `refund` cho mỗi top-up.
  creditTransactions: many(creditTransactions),
  refunder: one(users, { fields: [topUps.refundedBy], references: [users.id] }),
  eInvoice: one(eInvoices, { fields: [topUps.id], references: [eInvoices.topUpId] }),
  loyaltyTransactions: many(loyaltyTransactions),
}));

export const eInvoicesRelations = relations(eInvoices, ({ one, many }) => ({
  topUp: one(topUps, { fields: [eInvoices.topUpId], references: [topUps.id] }),
  adjustments: many(invoiceAdjustments),
}));

export const invoiceAdjustmentsRelations = relations(invoiceAdjustments, ({ one }) => ({
  eInvoice: one(eInvoices, { fields: [invoiceAdjustments.eInvoiceId], references: [eInvoices.id] }),
}));

export const loyaltyAccountsRelations = relations(loyaltyAccounts, ({ one, many }) => ({
  driver: one(drivers, { fields: [loyaltyAccounts.driverId], references: [drivers.userId] }),
  transactions: many(loyaltyTransactions),
}));

export const loyaltyTransactionsRelations = relations(loyaltyTransactions, ({ one }) => ({
  account: one(loyaltyAccounts, {
    fields: [loyaltyTransactions.loyaltyAccountId],
    references: [loyaltyAccounts.id],
  }),
  session: one(sessions, { fields: [loyaltyTransactions.sessionId], references: [sessions.id] }),
  topUp: one(topUps, { fields: [loyaltyTransactions.topUpId], references: [topUps.id] }),
}));

// ---- ops ----
export const faultEventsRelations = relations(faultEvents, ({ one, many }) => ({
  chargePoint: one(chargePoints, {
    fields: [faultEvents.chargePointId],
    references: [chargePoints.id],
  }),
  connector: one(connectors, { fields: [faultEvents.connectorId], references: [connectors.id] }),
  acknowledgedByStaff: one(operatorStaff, {
    fields: [faultEvents.acknowledgedBy],
    references: [operatorStaff.userId],
  }),
  reports: many(faultReports),
  tickets: many(maintenanceTickets),
}));

export const faultReportsRelations = relations(faultReports, ({ one }) => ({
  driver: one(drivers, { fields: [faultReports.driverId], references: [drivers.userId] }),
  connector: one(connectors, { fields: [faultReports.connectorId], references: [connectors.id] }),
  faultEvent: one(faultEvents, {
    fields: [faultReports.faultEventId],
    references: [faultEvents.id],
  }),
  clearedByStaff: one(operatorStaff, {
    fields: [faultReports.clearedBy],
    references: [operatorStaff.userId],
  }),
}));

export const maintenanceTicketsRelations = relations(maintenanceTickets, ({ one }) => ({
  faultEvent: one(faultEvents, {
    fields: [maintenanceTickets.faultEventId],
    references: [faultEvents.id],
  }),
  assignee: one(operatorStaff, {
    fields: [maintenanceTickets.assignedTo],
    references: [operatorStaff.userId],
  }),
}));

export const policyTemplatesRelations = relations(policyTemplates, ({ one }) => ({
  createdByUser: one(users, { fields: [policyTemplates.createdBy], references: [users.id] }),
}));

export const reservationsRelations = relations(reservations, ({ one }) => ({
  driver: one(drivers, { fields: [reservations.driverId], references: [drivers.userId] }),
  connector: one(connectors, { fields: [reservations.connectorId], references: [connectors.id] }),
}));

// ---- ocpp-gateway ----
export const ocppMessageLogRelations = relations(ocppMessageLog, ({ one }) => ({
  chargePoint: one(chargePoints, {
    fields: [ocppMessageLog.chargePointId],
    references: [chargePoints.id],
  }),
}));

export const remoteCommandsRelations = relations(remoteCommands, ({ one }) => ({
  chargePoint: one(chargePoints, {
    fields: [remoteCommands.chargePointId],
    references: [chargePoints.id],
  }),
  requester: one(users, { fields: [remoteCommands.requestedBy], references: [users.id] }),
}));
