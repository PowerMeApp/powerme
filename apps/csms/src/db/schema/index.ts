/**
 * Schema Drizzle của CSMS — điểm vào duy nhất (`drizzle.config.ts` trỏ vào đây).
 *
 * Nguồn sự thật về cấu trúc DB là migration SQL viết tay trong `apps/csms/drizzle/`
 * (ADR-0008). File TypeScript ở đây phải khớp từng cột với SQL; partition theo tháng
 * (ADR-0007) chỉ có ở SQL. Mô tả từng bảng: `docs/THIET-KE-CSDL-VAT-LY.md`.
 */
export * from './enums.js';
export * from './users.js';
export * from './stations.js';
export * from './sessions.js';
export * from './tariffs.js';
export * from './reconciliation.js';
export * from './billing.js';
export * from './ops.js';
export * from './ocpp-log.js';
export * from './relations.js';
