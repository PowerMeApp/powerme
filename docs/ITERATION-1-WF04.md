# Iteration 1 — WF-04 "xử lý lỗi trụ" (pillar fault, alert and remote recovery) — FE-04

**Date:** 27/10/2026 (updated after review of PR #61, see §10) · **Owner:** Trần Trọng Nghĩa (WP4) · **Branch:** `wp4/fe-04-iteration-1-wf04` (from `main` @ `34ec95a`, merged with `main` @ `c107c94`)

**Sources:**
- Design: `docs/WF-04-XU-LY-LOI-TRU.md` (sequence diagrams 1–2, class diagram, mapping table §5, open questions §6), `diagrams/team/WF04-*`, AD-7 (`diagrams/ad/AD-7_fault_and_alert.puml`).
- State machines: STM-6 FaultEvent v0.2 (`diagrams/stm/STM-6_FaultEvent.puml`), STM-2 Connector, STM-1 ChargingSession, plus `docs/XAC-NHAN-STATE-MACHINE-T13.md`.
- Schema and ADRs: migration `0001` (`remote_commands`), ADR-0016 D-F (FaultService lives in `stations`).
- Simulator: `simulator/d1-hmi` (`fault` / `clearfault`, Reset = reboot).
- Format: `docs/ITERATION-1-WF03.md`.

---

## 1. Goal of this iteration

This is the first product code for WF-04. A pillar fault becomes an operator alert with the STM-6 lifecycle, and the operator can acknowledge it, reset the pillar remotely, or close it after a site visit.

| In | Out (later) |
|---|---|
| **STM-6 FaultEvent**: a pure class with 7 transitions (t2–t7) and creation t1. Every transition and the full 4 × 6 sweep are tested | **Driver fault report** (UC-CHG-05): no app API yet |
| **Fault raised** from `StatusNotification Faulted`, including **connector 0** (whole pillar, `connector_id` null) | **Maintenance tickets** (UC-OPS-08, «Should») |
| **One open fault per connector**: a repeated `Faulted` attaches to the open fault (the first `error_code` is kept), enforced in code (`SELECT … FOR UPDATE`) and in the DB (unique index, migration `0007`) | **Hide connector + void reservations** (AD-4, «Should») |
| **Auto-resolve** when the connector works again: `Available`, or straight to `Preparing` / `Charging` / `SuspendedEV(SE)` / `Finishing` / `Reserved` (t3 from `raised`, t5 from `resetting`, t7 from `acknowledged`). `Unavailable` after a reboot does **not** resolve | **Offline > 900 s → fault** (G19, ADR-0016): the timer location is to be agreed with Trí |
| **Acknowledge** (t2), **remote Reset** (t4) with a `remote_commands` row and a timeout timer, refused with 409 while another connector is charging unless the operator forces it, **Reset failed / rejected / timeout** (t6), **manual close** (t7 `OPERATOR_CLOSE`) | **Realtime** `alert.*` events (BE-08), **dashboard alerts page** (WP4 UI) |
| **Error-code guide**: all 16 OCPP 1.6 `ChargePointErrorCode` values with severity and an operator hint | Final hints for the four SRS hardware codes (waiting on WP1) |
| **Console API + "Faults" table**: list, acknowledge, reset, close | Login / `RolesGuard` (ADR-0011): `acknowledged_by` stays null from the console |

The session on the faulted connector needs **no new code**. The pillar sends `StopTransaction(reason Other)`, and the existing STM-1 #10 → #12 path closes and reconciles it. IT-1a and IT-1b prove this in both message orders.

---

## 2. Folder changes

```
apps/csms/
├── drizzle/0008_fe04-fault-events-wf04.sql   NEW: fault_events.reset_command_id + one-open-fault unique index
├── src/
│   ├── common/scheduler.ts                   NEW: Scheduler / TimeoutScheduler moved out of offline-grace (shared)
│   ├── config.ts (+ spec)                    FAULT_RESET_TIMEOUT_S (default 120)
│   ├── db/schema/ops.ts, relations.ts        resetCommandId, unique index, relation to remote_commands
│   ├── ocpp-gateway/
│   │   ├── ocpp-handlers.ts                  StatusNotification → SessionsService, then FaultService
│   │   └── offline-grace.service.ts          re-exports the Scheduler types (T61 code and tests unchanged)
│   ├── stations/
│   │   ├── stations.module.ts                + FaultService (provided and exported)
│   │   └── faults/
│   │       ├── fault-state-machine.ts (+ spec)   STM-6, pure
│   │       ├── fault.service.ts                  the only writer of fault_events
│   │       └── error-code-guide.ts (+ spec)      static data, 16 codes
│   └── console/
│       ├── console.router.ts (+ spec)        4 routes
│       ├── console.http.ts (+ spec)          backend interface + dispatch
│       ├── console.commands.ts               list / acknowledge / reset (sends the CALL) / close
│       ├── console.server.ts, console.module.ts  wiring (+ StationsModule)
│       └── console-page.ts                   "Faults" panel with buttons (hidden when nothing is open)
└── test/
    └── wf04-fault.integration.test.ts        NEW: 26 tests
infra/.env.example                            + FAULT_RESET_TIMEOUT_S
```

**Why migration 0008.** `main` has `0003` (T73 billing) and PR #58 (WP3) uses `0004`–`0007`; since #62 a test on `main` refuses two migrations with the same number. The first version of this PR used `0007` and collided with #58. The `migrate` helper applies every file not yet in `_migrations` in name order, so either merge order works, and the two sets touch different tables. A local DB that already applied the old `0007` must be rebuilt once (`npm run demo:reset`; integration tests call `resetAndMigrate`).

---

## 3. Modules

### 3.1 `FaultStateMachine` (`stations/faults/fault-state-machine.ts`)

- `apply(from, trigger)` returns `{ to, noop, no }` or throws `InvalidFaultTransitionError`, in the same shape as `SessionStateMachine`. Trigger names are exactly those in STM-6 v0.2.
- `initial()` returns `raised` (t1).
- `SIGNAL` on an open fault is a no-op. `resolved` is final: every trigger on it is rejected, and a new signal creates a new fault.

### 3.2 `FaultService` (`stations/faults/fault.service.ts`)

- **`onConnectorStatus(...)`** is called by `OcppHandlers` **after** `SessionsService.onStatusNotification`. Frames of one pillar are serialized, so the order is safe.
  - `Faulted`: t1, or attach to the open fault.
  - A working status (`RECOVERED_STATUSES`: `Available`, `Preparing`, `Charging`, `SuspendedEV`, `SuspendedEVSE`, `Finishing`, `Reserved`): t3 / t5 / t7. OCPP 1.6 lets a connector leave `Faulted` for any status (table I1–I8, `valid-transitions.ts`), so a fault that clears while a driver is already plugged in goes Faulted → Preparing → Charging and must close too. The STM-6 trigger keeps its name `CONNECTOR_AVAILABLE`.
  - `Unavailable` (reboot in progress) or an unknown status: nothing.
  - `raised_at` / `resolved_at` use the pillar's `timestamp` when the frame is **replayed** (`ctx.replay.replayed`), otherwise `received_at`. A pillar offline for 30 min that replays `Faulted` at 10:05 and `Available` at 10:07 gets those times, not the 10:35 reconnect. The pillar time is never later than `received_at` and never more than 30 days older (`eventTime`, `MAX_REPLAY_AGE_MS`); otherwise the pillar clock is wrong and `received_at` is used.
  - **Stale replays are ignored** (outcome `stale`, logged, frame still in `ocpp_message_log`): a working status older than the open fault's `raised_at` does not close it, and a `Faulted` older than the connector's last `resolved_at` does not reopen anything. Without this, queued `Charging` frames from before a cut would close a live fault now that every working status resolves.
  - An error here is logged and never turns a `StatusNotification` into a CALLERROR. CSMS mirrors status and never rejects one (T13).
- **`acknowledge`** → t2.
- **`beginReset`** → t4 in one transaction: INSERT `remote_commands` (Reset, pending) and set `fault_events.reset_command_id`. It then arms a timer of `FAULT_RESET_TIMEOUT_S`.
- **`markSent`** → command `sent`.
- **`onResetResult`**:
  - Accepted: the command becomes `accepted` and the fault stays `resetting`.
  - Rejected or error: the command becomes `rejected` / `failed`, and t6 runs.
  - A late result for a command no longer attached to a `resetting` fault only updates the command.
- **`onResetTimeout`** → t6, but only for the same command. A command with no result yet becomes `timeout`; an `accepted` command stays `accepted`.
- **`close`** → t7 `OPERATOR_CLOSE`.
- **`list`**: open faults first, then by severity, then newest — ordered **in SQL before `LIMIT`** (`CASE error_code …` built from `ERROR_CODE_GUIDE`), so newer minor faults never push an older critical one off the console's 20 rows.
- **`recoverAfterRestart`** runs at bootstrap. Timers are in RAM, as in T61. Each `resetting` fault is timed out if its command is older than the timeout, or re-armed for the remaining time.

**Who sends the Reset CALL.** `stations` must not import `ocpp-gateway` (ADR-0016 D-F), so the console sends it through `ConnectionRegistry`, the same way `remoteStop` does. The order is: check (409 if not `acknowledged`, the pillar is offline, another fault on the same pillar is already `resetting`, or another connector has a `pending` / `active` / `paused` / `stopping` / `orphaned` session; nothing is written) → `beginReset` → `markSent` → `client.call('Reset', {type})` → `onResetResult`.

**Reset on a busy pillar.** OCPP `Reset` reboots the whole pillar, so a driver charging on the other connector would be cut off without notice (BR-P07 asks for communicated downtime). The console answers 409 `sessions_active` with the connectors and session ids; the page asks a second confirmation and resends with `force=true`. The command is then stored with `payload = {type, force: true}` and the response carries `forced: true`. A session on the faulted connector itself does not block: WF-04 step 1 closes it. `pending` (remote start accepted, driver about to plug in) and `orphaned` (pillar reconnected but no live frame yet, so it may still be charging, STM-1 #18) count as well; a stale orphaned session therefore needs `force` until the 24 h hard cap moves it to `review`. The check runs before the reset transaction, so a session that starts in between is not caught — the pillar can start one at any moment anyway.

### 3.3 `ErrorCodeGuide`

- 16 codes, each with severity (critical / major / minor / none) and a hint. `NoError` = none. Unknown vendor codes fall back to `OtherError`.
- Severity **only orders the list**. It never disables a pillar (WF-04 Q11).
- The four codes with dedicated SRS handling are flagged `pendingWp1`: `GroundFailure`, `HighTemperature`, `OverCurrentFailure`, `PowerMeterFailure`. Which four they are is an assumption until WP1 confirms; a test fails when the list changes.

### 3.4 Console

| Method | Path | Result / errors |
|---|---|---|
| GET | `/api/admin/faults?status=open\|all&limit=` | list (default `open`, 100) · 400 for a bad status or limit |
| POST | `/api/admin/faults/{id}/acknowledge` | `{id, status}` · 404 · 409 `invalid_transition` |
| POST | `/api/admin/faults/{id}/reset?type=Soft\|Hard&force=true\|false` | `{fault_id, command_id, reset_status, fault_status, forced}` · 409 `fault_not_acknowledged` / `station_offline` / `reset_in_progress` / `sessions_active` · 502 `station_error` |
| POST | `/api/admin/faults/{id}/close` | `{id, status}` · 404 · 409 |

The reset type and `force` are query parameters because the console's HTTP layer reads no request bodies.

---

## 4. STM-6 transitions → tests

File: `apps/csms/src/stations/faults/fault-state-machine.spec.ts`. Names look like `STM-6 t<n>: <from> --<TRIGGER>--> <to>`.

| t | From → To | Trigger | Real trigger path in Iteration 1 | Integration test |
|---|---|---|---|---|
| t1 | ● → raised | `initial()` | `StatusNotification Faulted` (live or replayed) | IT-1a, IT-1b, IT-2, IT-10, IT-11, IT-14 |
| t2 | raised → acknowledged | `ACKNOWLEDGE` | `POST …/acknowledge` | IT-5 |
| t3 | raised → resolved | `CONNECTOR_AVAILABLE` | `StatusNotification` with a working status | IT-3, IT-4, IT-12, IT-14 |
| t4 | acknowledged → resetting | `RESET_SENT` | `POST …/reset` (`force=true` when another connector charges) | IT-6, IT-13 |
| t5 | resetting → resolved | `CONNECTOR_AVAILABLE` | `Available` after the reboot | IT-6 |
| t6 | resetting → acknowledged | `RESET_FAILED` | Reset `Rejected` / bad reply / timeout | IT-7, IT-7b, IT-8, IT-8b |
| t7 | acknowledged → resolved | `CONNECTOR_AVAILABLE` / `OPERATOR_CLOSE` | working status / `POST …/close` | IT-5, IT-12 / IT-9 |

**Sweep.** 4 states × 6 triggers = **24 pairs**: exactly **7 valid**, **3 no-ops** (`SIGNAL` on raised / acknowledged / resetting) and **14 rejected**. `canApply` agrees with `apply` on all 24.

---

## 5. Tests

### 5.1 Unit (no DB): 59 new

| File | Tests |
|---|---|
| `fault-state-machine.spec.ts` | 23: the 7 rows, t1, 3 no-ops, `resolved` is final, 6 named invalid pairs, error payload, 24-pair sweep, `canApply` = `apply` |
| `error-code-guide.spec.ts` | 20: 16 codes, 15 non-`NoError` entries have a severity and a hint, fallback for unknown codes, the 4 codes pending WP1, severity order |
| `console.router.spec.ts` | +9: defaults, 400 / 405 / 404, reset type, `force` (true / false / bad value) |
| `console.http.spec.ts` | +3: filter and limit pass-through, reset type and `force`, 409 shape |
| `config.spec.ts` | +6: `FAULT_RESET_TIMEOUT_S` default, valid value, and `0` / negative / decimal / text rejected |

### 5.2 Integration (real Postgres; frames through `OcppServer.processCall`; console over real HTTP): `test/wf04-fault.integration.test.ts`, 26 tests

| ID | Scenario | Checks |
|---|---|---|
| IT-1a | Session on c1 → `Faulted GroundFailure` → `StopTransaction(Other)` (WF-04 sequence 1 order) | 1 fault `raised`, `source = ocpp`; session `reconciled`, `stop_reason = Other`, 5000 Wh; connector `Faulted`; Charging → Faulted not flagged as unexpected |
| IT-1b | `StopTransaction(Other)` **before** `Faulted` (simulator order) | same result |
| IT-2 | `Faulted` ×3, the last with a different code | 1 fault, first code kept; a direct second INSERT is rejected by the unique index |
| IT-2b | `Faulted` on c1 and c2 | 2 independent faults |
| IT-3 | `Faulted` → `Available` | `resolved` (t3), never acknowledged |
| IT-4 | `Faulted` → `Unavailable` → `Available` | still `raised` after `Unavailable`; `resolved` after `Available`; 0 unexpected transitions |
| IT-5 | acknowledge (HTTP) → `Available` | `acknowledged_at` set; `resolved` (t7) |
| IT-6 | acknowledge → reset Hard (Accepted) → Boot → `Unavailable` → `Available` | CALL `Reset {type: Hard}` sent; command `accepted` with `sent_at` / `responded_at`; timer 120 s armed, then cancelled; t4 → t5 |
| IT-7 | Reset → `Rejected` | `acknowledged` (t6); command `rejected`; a second reset works |
| IT-7b | Reset CALL fails | 502; command `failed`; fault `acknowledged` |
| IT-8 | Reset Accepted, pillar comes back still `Faulted`, timer fires | `acknowledged`; command stays `accepted`; a repeated timeout is a no-op |
| IT-8b | timeout before any reply | command `timeout` |
| IT-9 | close before acknowledge → 409; acknowledge → close → close again | `resolved`, then 409 `invalid_transition`; connector stays `Faulted` |
| IT-10 | `Faulted` on connector 0 | `connector_id` null; c1 `Available` doesn't resolve it; c0 `Available` does |
| IT-11 | fault → resolved → fault again | new fault with a higher `event_no` |
| IT-12 | `Faulted` → `Preparing` → `Charging`; and acknowledged → `Unavailable` → `Charging` | resolved at `Preparing` (t3) without passing `Available`; still `acknowledged` after `Unavailable`, resolved at `Charging` (t7) |
| IT-13 | session on c2, fault on c1 acknowledged, reset; then reset with `force=true`; then a session on c1 itself | 409 `sessions_active` naming c2, **no** command and **no** CALL; forced reset `resetting` with `payload = {type: Soft, force: true}`; own-connector session does not block (`forced: false`) |
| IT-14 | replayed `Faulted` (cp 10:05) and `Available` (cp 10:07) received ~30 min later; then a live `Faulted` | `raised_at` 10:05, `resolved_at` 10:07; live frame uses `received_at` |
| IT-15 | 26 open faults: one old `GroundFailure`, 25 newer `WeakSignal`; `GET …?limit=20` | 20 rows, the critical one first |
| IT-16 | live `Faulted`, then a replayed `Charging` from before it; then live `Available` and a replayed `Faulted` from before that | fault stays `raised`; then exactly one fault, `resolved` (no reopen) |
| IT-17 | pillar time 1970 / 3 h in the future | `raised_at` / `resolved_at` = `received_at` |
| IT-18 | session on c2 set to `orphaned`, then `pending`; then two faults, reset c1 then c2 | 409 `sessions_active` both times; 409 `reset_in_progress`, one Reset CALL only |
| console 409 / 404 | reset when not acknowledged, unknown id, pillar offline | correct codes; **no** `remote_commands` row and **no** CALL sent |
| console list | open-only by default, severity first; `?status=all` | ordering |
| restart sweep | two `resetting` faults, one past the timeout and one not | `{timedOut: 1, scheduled: 1}`, remaining delay = 90 s |
| message log | every `StatusNotification` is in `ocpp_message_log` | — |

### 5.3 Real end-to-end run (D1 HMI simulator + CSMS + console, real WebSocket)

`npm run demo -- --reset --port-offset 200` with `FAULT_RESET_TIMEOUT_S=20` (27/10/2026):

1. HMI `fault` c1 `GroundFailure` → console shows fault #1 `raised`, severity `critical`.
2. Acknowledge, then Reset → pillar answers `Accepted`, fault `resetting`, and the pillar reboots (Boot + StatusNotification). The D1 simulator keeps the fault across a reboot, so the connector is still `Faulted`.
3. After 20 s → fault back to `acknowledged` (t6), command stays `accepted`.
4. Reset again, plus HMI `clearfault` during the reboot → connector `Available` → fault `resolved` (t5).

The frames (Reset, BootNotification, TriggerMessage, StatusNotification) are in `ocpp_message_log` and are attached to the PR draft.

---

## 6. How to run

The repo targets Node **24.18.1** (`.nvmrc`). On Node 22 the Jest suites that load NestJS fail with `createRequireEsmError`, so use Volta or nvm.

```bash
npm ci
npm run typecheck -w @powerme/csms
npm test -w @powerme/csms                                  # unit only
DATABASE_URL=postgresql://powerme:powerme@localhost:5432/powerme_test npm test -w @powerme/csms   # + integration
npm test -w @powerme/csms -- wf04 fault                    # only WF-04
npm run demo -w @powerme/csms                              # HMI + CSMS + console (section 5.3)
```

New environment variable: `FAULT_RESET_TIMEOUT_S` (integer seconds > 0, default 120).

---

## 7. Results (local, 27/10/2026, Node 24.18.1, Postgres 16.4 in Docker)

| Check | Result |
|---|---|
| `format:check`, `typecheck`, `build` | pass |
| Unit (no DB) | **245 passed**, 16 suites |
| Unit + integration (`DATABASE_URL`) | **407 passed, 26 suites** (after merging `main` @ `c107c94`): every existing WF-03 / WF-05 / T61 / T73 / console / migration test still passes |
| WF-04 integration | **26 / 26** |
| Real end-to-end (section 5.3) | raised → acknowledged → resetting → (timeout) acknowledged → resetting → resolved |

CI runs on PR #61.

---

## 8. Not done in this iteration

- Driver fault report API (UC-CHG-05) and `fault_reports`.
- Maintenance tickets, hiding the connector, voiding reservations («Should»).
- Offline > 900 s → `fault_events` (G19). It needs a timer next to `OfflineGraceService`, to be agreed with Trí.
- Realtime `alert.raised` / `alert.updated` / `alert.resolved` (BE-08), and the React dashboard alerts page.
- Who closed a fault: `fault_events` has no column for it, so it is only logged.
- The Reset timer is in RAM (rebuilt at startup). The target is a BullMQ delayed job, as for T61.

## 9. Open questions

The WF-04 §6 questions still apply. New ones from this iteration:

| # | Question | This iteration assumes | Who |
|---|---|---|---|
| 1 | Does the Ruihua pillar send `StopTransaction` before or after `Faulted`? | Both orders are handled (IT-1a / IT-1b) | Trí + vendor |
| 2 | A repeated `Faulted` with a **different** code: keep the first or update? | Keep the first; later codes are visible in `connector_status_events` | Nghĩa |
| 3 | Does a real fault survive a Reset like in the simulator? | Yes; the timeout path covers it | WP5 + vendor |
| 4 | Is 120 s the right Reset timeout for D1/YJ-EU hardware? | 120 s, configurable | WP1 / Trí |
| 5 | Add `fault_events.closed_by` / `resolved_by`? | Not yet (log only) | Nghĩa + WP1 (LERD-2) |
| 6 | Are these the right four SRS codes (`pendingWp1`)? | GroundFailure, HighTemperature, OverCurrentFailure, PowerMeterFailure | WP1 |
| 7 | Where does the offline > 900 s fault timer live (G19)? | Out of scope | Trí + Nghĩa |
| 8 | A **replayed** `Faulted` that arrives **after** a live recovery would open a fault that is already over. | **Handled** after self-review: ignored when older than the last `resolved_at` (IT-16). `SessionsService` still mirrors a replayed status into `connectors.status`, so the connector can show an old status until the next live frame | Trí + Nghĩa |
| 9 | STM-2 v0.1 draws only `Faulted → Available` ("fault cleared"); OCPP allows `Faulted` → any status | Code resolves on every working status (§3.2); STM-2 should add the other exits | WP1 (Ân) |
| 10 | Should a forced Reset be allowed for operators, or only after the driver is warned in the app (BR-P07)? | Console allows `force` after a second confirmation; no driver notice yet | Nghĩa + WP3 |

---

## 10. Changes after review of PR #61 (27/10/2026)

| Finding | Level | Change | Test |
|---|---|---|---|
| Reset does not check charging sessions, but Reset hits the whole pillar | blocking | 409 `sessions_active` unless `force=true`; second confirmation in the console; `payload.force` recorded | IT-13, router / http specs |
| Migration `0007` collides with PR #58 | blocking | Renamed to `0008`; merged `main` (#62 makes the migration tests list-independent and refuses duplicate numbers) | migration-0001 "each number once" |
| A fault only closes on `Available` | should fix | Any working status resolves (`RECOVERED_STATUSES`) | IT-12 |
| Replay flag ignored for `raised_at` | should fix | Replayed frames use the pillar's `timestamp` | IT-14 |
| List limited before sorting by severity | should fix | Order in SQL, then `LIMIT` | IT-15 |
| *(self-review)* replayed old frames could close a live fault; pillar clock trusted blindly; `orphaned` / `pending` sessions not checked; two Resets on one pillar | — | stale guard, `eventTime` clamp, wider session check, 409 `reset_in_progress` | IT-16, IT-17, IT-18 |
| PR also carried UC-ADM-08 and the dashboard package diagram; empty description | minor | Kept in this PR at the owner's choice (they are WP4 dashboard design docs for Iteration 1); listed separately in the PR description with Khang tagged for the billing part. A copy is also on `wp4/fe-09-billing-exceptions-uc-adm-08`. PR description written by Trí at merge time | — |
| FaultService error is only logged (no retry or sweep): a `Faulted` that fails to write never raises an alert | should fix | **Deferred** to after Review 2 — sweep `connector_status_events` for `Faulted` rows without a `fault_events` row | — |
| Hard reset recorded `failed` (HTTP 502) when the pillar reboots before sending CALLRESULT | minor | **Deferred** — the fault still closes through t7 when the connector reports a working status | — |
| *(re-review)* stale guard compares pillar time with server time: a pillar clock 10 min slow makes the replayed recovery look older than the live `Faulted`, so the fault stays `raised` | should fix | **Deferred** — fix before Review 2 if time allows (allow a skew window or compare receive order) | — |
