# Design Brief — WP2 input (for BM01, sections 3, 4, 5, 6, 7, 8 and Appendix A)

**Author:** Ngô Văn Minh Trí (WP2, Team Leader) · **First version:** 23/10/2026 · **This revision:** 28/10/2026 for Review 2 on **Thursday 29/10/2026** · **Status:** input for the team Design Brief; Ân assembles the final 4-page document.
**Repo:** `github.com/PowerMeApp/powerme`. Tag `review-2` = **`1cead5d`** (moved by Trí on 28/10 to `main` after PR #64; the first tag `16c8d06` of 26/10 is the commit the self-review BM02 was run on and stays referenced by the BM02 files). **The council reviews code on `main`** (agreed 27/10); every number below is from `main` at `fa13170`–`1cead5d` (27/10, after PR #44–#64) unless a commit is named.
**Honesty note:** every number is taken from a file, a test run or a CI run in the repo. Cells that still need the registration form v1.3 FR identifiers say **"map from form v1.3"**.

**What changed since 23/10 (one line each, so Ân can update BM01 §1.1 and the council can trace):** offline grace 120 s before `orphaned` (ADR-0016, #44, #59) · `gap_detected` now ends in `reconciled`, not `review` (#56) · RFID card accepted only when `status = active` (#56) · false-replay tolerance 5 s (#45) · billing schema `0003` matching LERD-1 v0.4 with 4 money-safety constraints (#60) · pillar login rate limit (#54) · staging kit (#48, #63) · WP3 charging service with settlement (#58) and WP4 fault handling with remote Reset (#61) now sit on the OCPP path owned by WP2.

---

## Section 3 — Key Design Decisions (exactly 5 for the team; WP2 proposes these, Ân may swap one for a WP3/WP5 decision)

| # | Decision | Alternatives considered | Chosen — and why | Owner | Related FR / diagram |
|---|---|---|---|---|---|
| D1 | **Backend shape** (ADR-0002) | Microservices; Python/FastAPI monolith; Go | **One NestJS process, modules by business capability.** A session and its ledger entry must be written in one DB transaction (seen in #58: `sessions` + `credit_transactions` + `charging_statements` in one transaction) — splitting servers would create, between our own services, the very data-loss class the research measures. Fits 5 people / 13 weeks | Trí | ARCH-1, PKG-1 |
| D2 | **OCPP transport layer** (ADR-0004) | `mobilityhouse/ocpp` (Python), `ocpp-go`, hand-rolled JSON-RPC over `ws` | **`ocpp-rpc@2.2.1`, pinned exactly.** Most-downloaded Node OCPP library (26,355/month on 12/09/2026 vs 493 for the next), MIT, schema validation for 1.6. The three things it does not do — per-pillar inbound serialisation, closing a stale socket on reconnect (code 1012), business logic — are ours, in `src/ocpp-gateway`, tested | Trí | WF-03 seq, STM-3 |
| D3 | **Log every frame before processing** (ADR-0005) | Log after handling; derive history from business tables | **Append-only `ocpp_message_log`, written before any handler runs** (DB trigger forbids UPDATE/DELETE). Crash protection and the experiment's ground truth; without it reconciliation results cannot be audited | Trí | LERD-2, NFR-OCPP-03 |
| D4 | **Replay handling without protocol support** (ADR-0009/0010, STM-1) | Trust charge-point timestamps; wait for OCPP 2.0.1 `offline`/`seqNo`; drop late messages | **Dual timestamps (`cp_timestamp` untrusted, `received_at` trusted) + a connection epoch stored in the DB + 5-column idempotency key for `StartTransaction`.** OCPP 1.6 gives the Central System no flag to tell queued replays from live messages (OCA fixed it only in 2.0.1); the D1 pillar is 1.6 only. Evidence: EXP-01 (live skew 0 s vs replay 104–127 s) | Trí | STM-1, WF-03 seq "Replayed StartTransaction" |
| D5 | **Grace period before a session is orphaned** (ADR-0016, #44/#59) | Orphan on socket close (Iteration 1); never orphan, wait for `StopTransaction`; orphan after the OCPP heartbeat timeout (900 s) | **120 s in-process timer, re-armed from the DB after a restart.** A 4G pillar drops and re-attaches within a minute routinely; orphaning at once produced false `orphaned → active` flips in the demo. 900 s would hide a real outage from the operator for too long. 120 s is WP1's decision (26/10) and is one env variable (`OFFLINE_GRACE_S`) so the experiment can vary it | Trí (code), Ân (value) | STM-1 #13–15, #18; NFR-OCPP-07 |

Earlier D4 "No Redis pub/sub on the transaction path" (ADR-0006) still holds; dropped from the five only because it has no code consequence yet (no realtime layer exists).

---

## Section 4 — Top Risks (3)

| # | Risk | Impact | How we verify or mitigate | Owner |
|---|---|---|---|---|
| R1 | **No physical charger (R-H01) — confirmed 27/10: the supervisor cannot borrow a Ruihua unit.** All behaviour is simulated | Results may not transfer to Ruihua firmware; the `meterStop` contradiction seen in EXP-01 may be simulator-specific | Two independent clients: SAP e-mobility simulator v4.12.0 (third-party, Apache-2.0, configured from the D1 manual: DC 120 kW, 2 guns, MeterValues 10 s) and the team's `d1-hmi`; scenarios mapped to OCA test cases TC_037_1, TC_037_3, TC_039 (Mandatory for the Central System); every unconfirmed vendor behaviour listed as an assumption in ADR-0012 and `simulator/d1-hmi/README.md`; the report's Limitations section says "verified against the OCPP 1.6J specification and the D1 manual, not against Ruihua firmware" | Trí |
| R2 | **`ocpp-rpc` has one maintainer** (235 of 241 commits), last release 2.2.1 (17/07/2025) | Library stalls → we own it | Version pinned exactly; MIT allows a vendored copy; dependency surface is `ws`, `ajv`, `ajv-formats`, `backoff`; gateway behaviour covered by our own tests, not the library's | Trí |
| R3 | **Research validity.** EXP-01 is a single run on one simulator, disconnect by closing the socket, not a half-open 4G drop; the reconciliation on/off switch (F30) does not exist yet | A reviewer may call the finding anecdotal | 30 runs × 3 scenarios with pre-defined metrics (NFR-REC-01), ablation on/off, SteVe baseline; add a proxy that drops packets instead of closing the socket; limits stated in EXP-01 §"Điều KHÔNG được kết luận" | Trí + Khang |

---

## Section 5 — Known Gaps (WP2 side; includes every High finding Kept/Planned in BM02 as the form requires)

| # | Gap | Location | Plan | Owner | Due |
|---|---|---|---|---|---|
| G1 | **No HTTP/Socket.IO exposure for the app and dashboard.** The service layer exists since #58 (`DriverChargingService`: app start/stop, credit check, settlement; `station-search.ts`), but no REST route, no `openapi.json`, no realtime | `apps/csms/src/sessions/driver-charging.service.ts`, `.env.example` "no Driver HTTP API yet" | REST contract for status/ETA (now a WP2 commitment in form v1.3, T77) by 30/10; routes Week 9; realtime Week 10 | Trí (contract), Sơn (routes) | 30/10, 14/11 |
| G2 | **3 of the 22 STM-1 transitions have no trigger yet** (BM02 F16, High, Planned): `REMOTE_START_ACCEPTED`/`START_TIMEOUT` (the `pending` state — `RemoteStartTransaction` *is* sent by #58 but not driven through STM-1), `HARD_CAP_EXCEEDED` (24 h), `OPERATOR_RESOLVED` (review → reconciled). **Closed by #58:** `STOP_REQUESTED`, `REMOTE_STOP_REJECTED` (RemoteStop on driver stop and on the credit cut-off BR-P19) | `session-state-machine.ts`, grep of callers | Iteration 2 | Trí | 07/11, 14/11 |
| G3 | **Staging not running.** Config complete and CI-built (#48: Dockerfiles, Compose with Caddy TLS + Postgres 16.4, deploy/rollback/seed, `deploy-staging.yml`; #54 login rate limit; #63 `OCPP_TRUST_PROXY`), GHCR images public; no VPS yet (Azure for Students pending). Demo at Review 2 runs locally (allowed); Defense 1.1 requires staging | `infra/staging/` | VPS + DNS + secrets + first deploy | Trí + Ân | 07/11 |
| G4 | **Experiments not yet controlled**: no repeats, no SteVe baseline (needs Docker), SAP lacks 4 config keys (`LocalAuthorizeOffline`, `LocalPreAuthorize`, `TransactionMessageAttempts`, `TransactionMessageRetryInterval`) — mandatory before the 30 runs now that no real pillar will be available | `apps/csms/lab/simulator/README.md` | Patch SAP + 30 × 3 runs | Khang + Trí | 14/11 |
| G5 | **RFID-started `csms_billed` sessions are not priced.** #58's settlement covers only `origin = 'app_qr'` with a driver intent; a session opened by an online card at the pillar (BR-P23) is reconciled but never debited | `charge-settlement.service.ts` (`s.origin='app_qr' AND EXISTS intent`) | Extend settlement to card sessions (needs linked driver, BM02 F29) | Sơn + Trí | 07/11 |
| G6 | **Reconciliation cannot be switched off** (BM02 F30, High, Planned); the ablation experiment needs `RECONCILIATION_ENABLED` | `reconciliation.service.ts` | Config flag + test | Trí | 14/11 |
| G7 | **Security Profile 2 is half done** (BM02 F31, High, Fixed in part + Planned): Basic Auth per pillar with scrypt + rate limit are in; **no TLS in any running environment** (Caddy `wss` only in staging config, G3); operator console has no auth (loopback + SSH tunnel) | `pillar-auth.service.ts`, `pillar-login-limiter.ts`, `infra/staging/Caddyfile` | TLS when staging runs; console auth with RolesGuard | Trí, Ân | 14/11 |
| G8 | **Authorize does not check the linked driver or credit for cards** (BM02 F29, High, Fixed in part + Planned): card `status` is checked since #56; BR-P23 (card linked to a driver) and BR-P18 (credit ≥ start minimum) are checked only for app tags (#58 `authorizeAppTag`), not for cards | `sessions.service.ts` `classifyIdTag`, `driver-charging.service.ts` | Card path reuses `authorizeAppTag` rules | Trí | 07/11 |
| G9 | **Offline grace timer is in-process** (ADR-0016 D-A): `setTimeout`, re-armed by `OfflineGraceService.recoverAfterRestart` on boot; no multi-instance support | `offline-grace.service.ts` | BullMQ delayed job when Redis lands | Trí | Iteration 2 |
| G10 | **No offline alert** after 900 s of silence (NFR-OCPP-07; ADR-0016 wants a `FaultEvent`). #61 handles `Faulted` only; `is_online`/`online_changed_at` are the inputs | `stations/faults/fault.service.ts` | WF-04 extension | Nghĩa | 14/11 |
| G11 | **STM-3 operator flow has no caller**: `disabled`/`decommissioned` are never set; connectivity is separate from lifecycle since migration 0002 | `pillar-lifecycle-policy.ts` | HTTP endpoints disable/enable/decommission | Ân (Trí reviews) | 14/11 |
| G12 | **Schema-invalid inbound frames are not logged** (`ocpp-rpc` strict mode drops them before the handler; BM02 F42) | `ocpp-message-logger.ts` | Hook `strictValidationFailure` | Trí | 14/11 |
| G13 | **Most NFRs cannot be measured yet**: no `prom-client`, `infra/k6/` empty (BM02 F04, F46) | — | Measurement tooling | Trí + Khang | 20/11 |
| G14 | **Staged `meterStop` in the demo.** `STALE_METERSTOP=1` makes the HMI replay a stale `meterStop` after reconnect, copying what SAP did in EXP-01, so the demo reaches `review`. Not confirmed firmware behaviour; disclosed on screen | `simulator/d1-hmi`, `docs/DEMO-REVIEW-2.md` | Keep disclosed; cannot be confirmed without a real unit (R1) | Trí | — |
| G15 | **Deferred findings from the 27/10 review of #58 and #61 that touch the session path** (owners WP3/WP4, listed here because they change what WP2's state machine sees): auto RemoteStop timeout leaves a session in `stopping` with no retry; tariff-boundary meter sample must match the boundary time exactly; settlement on a closed wallet violates `credit_accounts_closed_check`; `fault_events` write failure is only logged; Hard Reset may be recorded `failed` when the pillar reboots before answering; pillar clock skew can keep a fault `raised` | PR #58 and #61 descriptions; `docs/ITERATION-1-WF04.md` §10 | Fix after Review 2 | Sơn, Nghĩa | 14/11 |
| G16 | **Embedded Postgres for the demo is 17.x beta; CI and staging use 16.4** | `apps/csms/demo/db-embedded.mjs` | Staging on 16.4 | Trí | with G3 |
| G17 | **Report 4 (SDD, 25/10) is behind `main` in four places** (checked 28/10): (a) no Dev/Staging/Production section — staging kit, deploy and rollback exist in `infra/staging/` (#48, #63) and are described in `docs/BANG-KHAI-BAO-CONG-NGHE.md`; (b) ADR-0016 shown as "code change pending (T61)" — T61 merged in #44 before the tag, default 120 s since #59, `OfflineGraceService` missing from the WF-03 class table; (c) "32 tables, D1/D2/D4 open" — tag has 34, `main` has 42 (migrations 0003–0008), D1 closed by 0003, D4 by 0001, D2 decided the other way (keep `earn/redeem/expire/adjust` + `restore`); (d) WF-04 class diagram names `StationsService`, `ConnectorStateMachine`, `RemoteCommandService`, `OcppDispatchService`, `RealtimeGateway` — none exists; code has `FaultService`, `FaultStateMachine`, console `resetFault` (409 when a session is active unless `force`). Smaller: `console` package absent; `openapi.json` does not exist; `reconciliation_records` verdict list wrong (`consistent` writes no record; `gap_detected` → `reconciled`) | Report 4 §1.1, §1.2.1, §2, §3.4.1, §3.5 | Ân updates the docx from this row and adds a PDF to `docs/requirements/` | Ân (WP2, WP4 supply text) | 29/10 |

Closed since 23/10 (for BM03/§1.1 traceability): G6-old enum mismatch (migration 0001, #36); G9-old false replay flag (#45); G12-old requirements not in repo (#34 — form v1.2/v1.3, Report 1, SRS are in `docs/requirements/`; **Report 4 (SDD, 15 MB docx) is still outside the repo** — Ân to add a PDF before 29/10 so the council can check SDD against `main`); G17-old "no billing schema" (#60 — settlement itself is WP3, #58); G18-old grace default 30 s placeholder (#59, 120 s).

---

## Section 6 — Mandatory features (WP2)

FR identifiers: map from form v1.3. Each criterion is written to become one pass/fail test; "Test" names the automated test that exists on `main`.

| ID | Feature | Actor | Acceptance criteria (testable) | Test | Status |
|---|---|---|---|---|---|
| F-W2-01 | OCPP connection, identity and Basic Auth | Pillar | `/ocpp/<serial>` with subprotocol `ocpp1.6` and a correct password is accepted; wrong/missing password → 401; 5 failures per (serial, IP) or 20 per IP in 60 s → 429 for 15 min (an attacker locks only their own key, not the real pillar); a second socket with the same identity closes the first with code 1012 | `wf05-onboarding.integration`, `pillar-login-limiter.spec`, `t61-ket-noi-va-an-han.integration` | Done |
| F-W2-02 | Frame logging | CSMS | One `ocpp_message_log` row per frame that reaches a handler, written before side effects; UPDATE/DELETE raise an error | `migration-0001.integration` (trigger), `wf03-exp01.integration` (row per frame) | Done (limit: schema-invalid frames not logged, G12) |
| F-W2-03 | Session start idempotency | Pillar | Replaying `StartTransaction` with the same `(charge_point, connector, idTag, meterStart, cp_timestamp)` returns the original `transactionId`, creates no second session, records one `duplicate` reconciliation row | `wf03-exp01.integration` | Done |
| F-W2-04 | Session lifecycle (STM-1) | CSMS | Each of the 22 transitions is accepted; every other (state, event) pair throws `InvalidTransitionError`; every change writes `session_status_history` | `session-state-machine.spec` (full sweep), `session-history.integration` | Done |
| F-W2-05 | Offline grace (ADR-0016) | Pillar, CSMS | Socket closed → session unchanged for `OFFLINE_GRACE_S` (120 s); reconnect inside the window → nothing happens; after the window → `orphaned`; a CSMS restart re-arms or applies pending timers from the DB | `offline-grace.service.spec`, `t61-ket-noi-va-an-han.integration` | Done |
| F-W2-06 | Replay detection | CSMS | A message whose `cp_timestamp` is > 5 s before `epoch_opened_at` is flagged `before_epoch`; > 5 s before receipt → `skew`; otherwise live | `replay-detector.spec` | Done |
| F-W2-07 | Reconciliation | CSMS, Operator | On stop: `meterStop` below the last sample beyond 1 Wh or a non-monotonic series → `conflict` + status `review`; a gap > 3 × 10 s with a consistent total → `gap_detected` + `reconciled`; consistent → `reconciled`; EXP-01 trace → tx 3 in `review` (242 vs 1042 Wh) | `reconciliation.service.spec`, `wf03-exp01.integration` | Done |
| F-W2-08 | Card authorisation by registry | Pillar | `Authorize`: card `active` → Accepted, `blocked` → Blocked, `unlinked`/unknown → Invalid; a `StartTransaction` that arrives anyway is kept as `unattributed` with an `unknown_id_tag` record, never dropped | `authorize-status.spec`, `session-history.integration` | Done (driver link + credit for cards: G8) |
| F-W2-09 | Connector status mirroring | Pillar | Every `StatusNotification` is stored; a transition outside the OCPP 1.6 table is stored and flagged `unexpected_transition` | `valid-transitions.spec`, `session-history.integration` | Done |
| F-W2-10 | Remote commands to the pillar | Operator, CSMS | `Reset`, `RemoteStopTransaction`, `RemoteStartTransaction`, `ChangeAvailability`, `TriggerMessage` are sent with a `remote_commands` row and a timeout (30 s / `RESET_CALL_TIMEOUT`); Accepted/Rejected/timeout each update the row and the session or fault state | `wf04-fault.integration` (Reset), `wf01-driver-charging.integration` (RemoteStop/Start) — code owned with WP3/WP4 | Done for Reset/RemoteStop; RemoteStart not wired to STM-1 (G2) |

## Section 7 — Non-functional requirements (≤ 6 rows for the team; WP2 proposes 4)

| ID | Quality attribute | Metric | Threshold | Measurement method | Status |
|---|---|---|---|---|---|
| NFR-OCPP-03 | Message integrity | Acknowledged transaction messages lost | 0 | Count `ocpp_message_log` rows vs frames sent by the simulator in the 30-run experiment | Asserted per frame in integration tests; 30 runs pending (G4) |
| NFR-REC-01 | Reconciliation correctness | Sessions ending with the correct energy figure or escalated with evidence, 30 runs × 3 disconnect scenarios, on vs off vs SteVe | ≥ 95 % correct with reconciliation on; result with reconciliation off reported | Scripted runs, labelled trace | Pending (G4, G6) |
| NFR-OCPP-07 | Offline detection | Time from last message to pillar marked offline / alert | Socket close: immediate (done); silent pillar: ≤ 900 s (not implemented, G10) | Scenario run with timestamps | Partly |
| — | Per-pillar ordering | Out-of-order writes for one pillar under a burst of replayed frames | 0 | `inbound-serializer.spec` with concurrent arrivals | Measured (unit) |
| — | Reproducibility | `npm run demo` from a clean checkout to a running system | ≤ 5 min | Timed run (rehearsed 28/10) | Measured locally |
| — | Test automation | Share of committed WP2 test cases running in CI | ≥ 50 % | CI job count | 310 WP2 tests automated in CI (see A3) |

## Section 8 — Ownership map (WP2 row)

| Member | Role | Owned parts (2–3) | Main workflow owned | Key decisions / PRs |
|---|---|---|---|---|
| Ngô Văn Minh Trí | Team Leader, WP2 | OCPP gateway & connection handling (`ocpp-gateway`, `stations/pillar-auth`) · session state machine & persistence (`sessions`, migrations 0000–0003) · reconciliation engine (`reconciliation`) | **WF-03 Connection loss and reconciliation** | ADR-0002/0004/0005/0009/0010/0016 (D1–D5); PRs #36, #44, #45, #56, #59, #60, #62; reviews and merges of #54, #58, #61 |

Cross-WP note for the reviewer: WP3 (#58) and WP4 (#61) code is called from WP2's `OcppHandlers` (`driverCharging`, `faults`, both `@Optional()`); the gateway stays the owner of ordering and logging. Each file in `apps/csms/src/{ocpp-gateway,sessions,reconciliation}` carries a header stating purpose and the ADR/STM it implements; AI assistance is declared in `docs/BANG-KHAI-BAO-CONG-NGHE.md`.

---

## Appendix A — Defense 1.1 targets (WP2 part)

### A1. Main workflow
| ID | Workflow | Actors | Trigger | Business outcome | Features | Entity states | Owner |
|---|---|---|---|---|---|---|---|
| WF-03 | Connection loss and reconciliation | Pillar, CSMS, Operator | Pillar socket closes while a session is active | A session interrupted by a connection loss ends in a consistent energy figure, or is escalated to an operator with evidence; no energy delivered is lost or double-counted | F-W2-01…07 | ChargingSession: `active → (grace) → orphaned → active → closed → reconciled` or `→ review` | Trí |

### A2. Demo scenarios (local for Review 2; staging for Defense 1.1 — run status in `docs/DEMO-REVIEW-2.md`)
| ID | Workflow | Type | Preconditions and data | Main steps | Expected result | Presenter |
|---|---|---|---|---|---|---|
| DS-03a | WF-03 | Main | `npm run demo` (seeded pillar `RH24D1-00001`, two guns, cards), `OFFLINE_GRACE_S=20` for the demo, `STALE_METERSTOP=1` | Start 2 sessions on the HMI → cut network 60 s → reconnect → stop | Console: `0 online`, after 20 s both sessions `orphaned`; on reconnect replayed frames flagged, sessions back to `active`; on stop `conflict` record, status `review` with the energy difference shown | Trí |
| DS-03b | WF-03 | Exception | Session already exists | Pillar re-sends `StartTransaction` | No second session; original `transactionId` returned; one `duplicate` record | Trí |
| DS-03c | WF-03 | Exception | Card not in registry or `blocked`; pillar offline when swiped | Reconnect, replay `StartTransaction` | Session kept as `unattributed` with an `unknown_id_tag` record carrying `card_status`; not dropped | Trí |
| DS-03d | WF-03 | Exception | Network cut shorter than the grace period (< 20 s in the demo) | Cut 10 s, reconnect | Sessions never leave `active`; no `orphaned` row in `session_status_history` | Trí |
| DS-03e | WF-03 | Exception | `STALE_METERSTOP=0` (honest pillar), samples lost during the cut | Cut 60 s, reconnect, stop | `gap_detected` record, status `reconciled` automatically — no operator action | Trí |

Council-chosen data: the grace period, the cut length and the stale `meterStop` are all switches (`OFFLINE_GRACE_S`, HMI "Rớt mạng (s)", `STALE_METERSTOP`), so the council can vary them live.

### A3. Functional test-case target — WP2 share
| Source | Count | Minimum per item | Subtotal |
|---|---|---|---|
| Mandatory features (Section 6) | 10 | 3 | 30 |
| Main workflows (end-to-end) | 1 | 1 | 1 |
| State transitions of main entities: STM-1 | 22 | 1 | 22 |
| State transitions: STM-3 (pillar lifecycle, `pillar-lifecycle-policy.ts`) | 6 | 1 | 6 |
| Agreed NFRs (Section 7) | 4 | 1 | 4 |
| **Committed minimum (WP2)** | | | **63** |

Automated today on `main` (`fa13170`, jest JSON run 28/10, same count as CI of 27/10): **559 tests in 32 suites for the whole CSMS**. By owner (each test counted once): **WP2 310** (config, gateway, sessions, reconciliation, migrations 0000–0003, console, T61, WF-03/EXP-01, session history), WP1 34 (`wf05-onboarding`, `pillar-credential`, `pillar-login-limiter`, `pillar-lifecycle-policy`), WP3 146 (`wf01-driver-charging`, `charging-runtime`, `migration-wp3`, charge-policy specs), WP4 69 (`wf04-fault`, fault specs). WP2 automation ratio against the committed minimum of 63: well above 50 %. Known flakiness: 2–3 timing-dependent tests in `wf01-driver-charging` (WP3) fail about one run in three and pass on rerun; reported to Sơn 28/10. One WP2 test (`t61` recovery sweep) had the same kind of fixed 150 ms wait; replaced by a bounded poll on 28/10 (PR #65).
