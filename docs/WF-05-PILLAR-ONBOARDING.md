# WF-05 Pillar onboarding — Iteration 1 (T35)

Owner: Trần Đức Ân (WP1) · Reviewer: Ngô Văn Minh Trí (WP2) · 25/10/2026
Design: Report 4 §3.6 (CD-5, SD-5a, SD-5b), AD-8 v2.0, STM-3 v0.3 (ADR-0016) · FR-09, FR-15 (registry), FR-16 · UC-ADM-03, UC-OPS-01, UC-INT-01

## What is built

| Design element | Code | Notes |
|---|---|---|
| `PillarLifecyclePolicy` (CD-5) | `apps/csms/src/stations/pillar-lifecycle-policy.ts` | STM-3 #1–#6 as one table; throws on any other move. Legacy `offline` lifecycle read as `in_service` until T61 |
| `CredentialService` (CD-5) | `apps/csms/src/stations/pillar-credential.ts` | 24-char random password, shown once; stored as scrypt hash (see decision below) |
| `PillarOnboardingService` (SD-5a) | `apps/csms/src/stations/pillar-onboarding.service.ts` | `registerDevice` (Admin only) → `registered`; `onboard` (operator staff, own site only) → `awaiting_connection`, 1–2 connectors `Unavailable`, display code `PM-{model}-{province}-{nnnn}` |
| Credential check at upgrade (SD-5b) | `apps/csms/src/stations/pillar-auth.service.ts`, hooked into `OcppServer.start()` | unknown 404 · `registered` / `decommissioned` 403 · wrong or missing Basic-auth password 401 |
| First connection (SD-5b) | unchanged WP2 code | `ConnectionRegistry.open()` sets `in_service`; Boot answered `Accepted` + interval; StatusNotification sets connectors `Available` |

Error → HTTP status for the future controller: `ONBOARDING_ERROR_STATUS` (403 other operator's site, 404 site missing, 409 serial not registered / already onboarded, 400 bad connectors).

## Tests (27 new, all automated in CI)

- `src/stations/pillar-lifecycle-policy.spec.ts` — TC-STM3-01..06 (one per transition) + 6 refused moves + `mayConnect` (15 cases).
- `src/stations/pillar-credential.spec.ts` — generation, salted hash, verify string/Buffer, wrong/missing/malformed (4).
- `test/wf05-onboarding.integration.test.ts` — the whole workflow on Postgres and a real OCPP-J WebSocket (`ocpp-rpc` client with Basic auth): Admin-only registry, not-onboarded pillar refused (403), 5 onboarding rejections with nothing written, success, double onboarding (409), 6 concurrent onboardings in one province get distinct display codes, wrong / missing credential (401), right credential → Boot Accepted, `in_service`, both connectors `Available` (8).

Run: `npm run demo:db -w @powerme/csms` in one terminal, then `DATABASE_URL=postgresql://powerme:powerme@127.0.0.1:54330/powerme_test npm test -w @powerme/csms`.

## Decisions taken in the review of PR #33 (Trí, 25/10)

1. **scrypt instead of argon2** for the pillar credential: `node:crypto`, no native add-on on Windows dev machines. The stored format `scrypt$N$r$p$salt$hash` is self-describing, so argon2 can be added later under its own prefix. **Accepted**; ADR-0011 amended.
2. **Pillars without a credential are refused (401) by default** (PR #35): accepted with a warning only when `ALLOW_LEGACY_NO_CREDENTIAL=true`, for `demo/seed.sql` and the WF-03 trace pillar, which were created before WF-05.
3. `PillarAuthService` is injected into `OcppServer` as `@Optional()`, so the WF-03 and console tests build the server unchanged.

## Not in this slice (Known gaps, Design Brief §5)

- HTTP endpoints `POST /api/admin/registry/pillars`, `POST /api/v1/operator/pillars`: wait for the `users` module (JWT + RolesGuard). The service already takes the caller's user id and resolves role and operator from the DB.
- Audit-log table: rejections are logged with `Logger.warn` only.
- GetConfiguration after Boot (SoC reporting, free-vend tag) and saving model / firmware from BootNotification.
- Disable / enable / decommission endpoints (STM-3 #4–#6 are in the policy and unit-tested).
- Operator dashboard screen for onboarding (Nghĩa, WP4).

## Security limits today (follow-up of the PR #33 review)

- **No TLS yet.** The CSMS listens on `ws://`, so the Basic-auth password travels in clear text. Security Profile 2 (ADR-0011) is the target; it is reached when Caddy terminates TLS on staging (T04). Until then, connect pillars and the simulator on the dev network only.
- **No rate limit on failed pillar logins.** Anyone who knows a serial can try passwords without delay. The password has ~144 bits of entropy, so guessing is not practical, but repeated failures still cost a scrypt hash each (CPU). Tracked as an issue to close before staging opens: limit failures per serial and per IP (e.g. 5 per minute, then 429 for 15 minutes) and log them for the audit log.
