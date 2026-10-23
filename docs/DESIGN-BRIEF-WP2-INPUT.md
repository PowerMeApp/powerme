# Design Brief — WP2 input (for BM01, sections 3, 4, 5, 6, 8 and Appendix A)

**Author:** Ngô Văn Minh Trí (WP2, Team Leader) · **Date:** 23/10/2026 · **Status:** input for the team Design Brief; Ân assembles the final 4-page document.
**Repo:** `github.com/PowerMeApp/powerme` · tag `review-2` (to be placed after the demo PRs merge).
**Honesty note:** every number below is taken from a file or a CI run in the repo. Where the registration form v1.2 is needed (FR identifiers, final tiering) and was not available to WP2, the cell says **"map from form v1.2"** instead of guessing.

---

## Section 3 — Key Design Decisions (exactly 5)

| # | Decision | Alternatives considered | Chosen — and why | Owner |
|---|---|---|---|---|
| 1 | **Backend shape** (ADR-0002) | Microservices; Python/FastAPI monolith; Go | **One NestJS process, modules by business capability.** A session and its invoice must be written in one DB transaction — splitting servers would create, between our own services, the very data-loss class the research measures. Matches ADR-0001 (monorepo) and the 5-person, 13-week budget | Trí |
| 2 | **OCPP transport layer** (ADR-0004) | `mobilityhouse/ocpp` (Python), `ocpp-go`, hand-rolled JSON-RPC over `ws` | **`ocpp-rpc@2.2.1`, pinned exactly.** Most-downloaded Node OCPP library (26,355/month on 12/09/2026 vs 493 for the next), MIT, schema validation for 1.6/2.0.1/2.1, source read and verified. The three things it does not do — per-charge-point inbound serialisation, closing a stale session on re-connect, business logic — are implemented and tested in `src/ocpp-gateway` | Trí |
| 3 | **Log every frame before processing** (ADR-0005) | Log after handling; derive history from business tables | **Append-only `ocpp_message_log`, written before any handler runs** (DB trigger forbids UPDATE/DELETE). It is both crash protection and the experiment's ground truth; without it reconciliation results cannot be audited | Trí |
| 4 | **No Redis pub/sub on the transaction path** (ADR-0006) | Pub/sub fan-out for everything | **Transaction path is synchronous + DB; pub/sub only feeds the UI.** Pub/sub drops messages when no subscriber is attached — it would manufacture exactly the loss we measure | Trí |
| 5 | **Replay handling without protocol support** (ADR-0009, STM-1/STM-3) | Trust charge-point timestamps; wait for OCPP 2.0.1 `offline`/`seqNo`; drop late messages | **Dual timestamps (`cp_timestamp` untrusted, `received_at` trusted) + a connection epoch stored in the DB.** OCPP 1.6 gives the Central System no flag to tell queued replays from live messages; the pillar here supports 1.6 only. A sample is a replay candidate when its `cp_timestamp` precedes its connection's `epoch_opened_at`. Evidence: EXP-01 (live skew 0 s vs replay 104–127 s) | Trí |

---

## Section 4 — Top Risks (3)

| # | Risk | Impact | Verification / mitigation |
|---|---|---|---|
| 1 | **No physical charger (R-H01).** All behaviour is simulated; the simulator answers the way its author expects a pillar to answer | Results may not transfer to Ruihua firmware; the `meterStop` contradiction seen in EXP-01 may be simulator-specific | Independent third-party simulator (SAP v4.12.0, Apache-2.0) rather than our own; every unconfirmed behaviour is labelled an assumption in `simulator/d1-hmi/README.md`; five vendor questions drafted (wallet card, free-vend `idTag`, config keys, measurands, integer-vs-decimal Wh); ask the supervisor for one session on a real unit |
| 2 | **`ocpp-rpc` has one maintainer** (235 of 241 commits) and its last npm release is 2.2.1 (17/07/2025) | Library stalls → we own it | Version pinned exactly, MIT licence allows a vendored copy; dependency surface is `ws`, `ajv`, `ajv-formats`, `backoff`; core behaviour covered by 115 automated tests |
| 3 | **Research validity.** EXP-01 is a single run on one simulator, disconnect by stopping the server (clean socket close), not a half-open 4G drop | A reviewer may call the finding anecdotal | Run 3 scenarios × N repeats with pre-defined metrics and a SteVe baseline; add a proxy that drops packets instead of closing the socket; report limits explicitly (done in `EXP-01` §"Điều KHÔNG được kết luận") |

---

## Section 5 — Known Gaps (WP2 side)

| # | Gap | Severity (own assessment) | Plan / owner / due |
|---|---|---|---|
| G1 | Only Iteration 1 exists: gateway, session state machine, reconciliation. **No driver/operator REST API for the app, no Socket.IO realtime, no billing hook, no TLS/Security Profile 2** | High | Station-search API 28/10 (Trí) → realtime Week 9 → TLS Week 10 |
| G2 | 5 of the 22 STM-1 transitions have no real trigger yet: RemoteStart/RemoteStop issuance, 24 h hard cap, start timeout, operator resolving `review` (see `docs/ITERATION-1-WF03.md` §4) | High | Iteration 2, Trí, 07/11 |
| G3 | No staging environment; the demo runs on a personal machine (acceptable for Review 2, **not** for Defense 1.1) | High | Shared-budget droplet, team decision, 31/10 |
| G4 | Experiments not yet controlled: no repeats, no SteVe baseline (needs Docker), SAP lacks 4 config keys (`LocalAuthorizeOffline`, `LocalPreAuthorize`, `TransactionMessageAttempts`, `TransactionMessageRetryInterval`) | Medium | Patch + 3×N runs, Khang (WP5) + Trí, 14/11 |
| G5 | WF-03 specification from WP1 (T62) is not yet available; `docs/WF-03-MAT-KET-NOI-VA-DOI-SOAT.md` is a WP2 draft derived from EXP-01 and STM-1 | Medium | Ân to reconcile, 28/10 |
| G6 | ADR-0009 and ADR-0012 still list enum values that differ from STM-1 / the DB (`origin`, `payment_mode`, table names `id_tags`); the DB enum `payment_mode` lacks a value for sessions opened by an unknown tag | Medium | Update ADRs, add `unattributed`, Trí, 25/10 |
| G7 | 14 internal inconsistencies in the repo (Node 22 vs 24, Postgres 16.4 vs 16, SteVe build, …) — `docs/BAO-CAO-HIEN-TRANG-REPO.md` §10 | Low | PM-01, Ân + Trí, 01/11 |
| G8 | Embedded Postgres used for the demo is 17.x beta; CI uses Postgres 16 | Low | Staging on Postgres 16 |

---

## Section 6 — Mandatory features (WP2)

FR identifiers must be mapped from the registration form v1.2 (not held by WP2). Acceptance criteria are written so each becomes a pass/fail test.

| Feature | Measurable acceptance criterion | Test (exists?) |
|---|---|---|
| OCPP connection & identity | A pillar connecting to `/ocpp/<serial>` with subprotocol `ocpp1.6` is accepted; a connection without the subprotocol is rejected; two connections with the same identity leave exactly one open | Unit/integration — `ocpp-server`, `connection-registry` (exists) |
| Frame logging | For every frame processed, one row exists in `ocpp_message_log` with `received_at` earlier than the handler's side effects; UPDATE/DELETE on the table raises an error | Integration (exists); trigger verified on PG (T11) |
| Session start idempotency | Replaying `StartTransaction` with the same `(charge_point, connector, idTag, meterStart, cp_timestamp)` returns the original `transactionId` and creates no second session | Integration (exists) |
| Session lifecycle (STM-1) | Each of the 22 defined transitions is accepted; every other (state, event) pair is rejected — 127 of 150 pairs throw `InvalidTransitionError` | Unit, 22 + 14 listed invalid + full sweep (exists) |
| Replay detection | A message with `cp_timestamp` earlier than its connection's `epoch_opened_at` is flagged replayed; one within 5 s of receipt on the current epoch is not | Unit (exists) |
| Reconciliation | For a stopped session, `meterStop − meterStart` is compared with the MeterValues series; a mismatch beyond tolerance yields a `conflict` record and session status `review`; EXP-01 trace → tx 3 ends in `review` with the 242 vs 1042 Wh difference | Integration on real trace (exists) |
| Connector status mirroring | Every `StatusNotification` is stored; a transition outside the OCPP table is stored **and** flagged `unexpected_transition`, never rejected | Unit (exists) |
| Remote commands to the pillar | RemoteStart/Stop/Reset/TriggerMessage/ChangeConfiguration reach a connected pillar and return its answer within 60 s or a timeout error | Lab (EXP-02), product code **not yet** — gap G2 |

## Section 7 — Non-functional requirements (≤ 6 rows)

| NFR | Metric · threshold | Measurement method | Status |
|---|---|---|---|
| Per-pillar ordering | Frames of one pillar are processed strictly in arrival order (0 out-of-order writes) | `InboundSerializer` test with concurrent arrivals | Measured (unit test) |
| Message-loss visibility | 100 % of frames received are present in `ocpp_message_log`; proposed threshold: replayed samples flagged with ≥ 95 % precision and recall on the labelled EXP-01 trace | Frame count + hand-labelled trace | Frame count: asserted in integration test; **precision/recall threshold proposed, not yet measured** |
| Reconnect detection | Server marks a pillar `offline` ≤ 60 s after a socket close or missed pings (hard cap 900 s) | Scenario run with timestamps | **Not yet measured** |
| Data integrity | Energy stored as integer Wh, money integer VND; DB rejects non-integer / negative values | Migration CHECK constraints + 11 violation cases (T11) | Measured on PG-lite; re-run on PG |
| Reproducibility | Demo data loads from script; `npm run demo` reaches a running system from a clean checkout in ≤ 5 min | Timed run | Pending (BE-09) |
| Test automation | ≥ 50 % of WP2 test cases run in CI | CI job counts | 115 automated in CI |

## Section 8 — Ownership map (WP2 row and cross-WP dependencies)

| Member | Owns (2–3 parts) | Main workflow |
|---|---|---|
| Ngô Văn Minh Trí (WP2) | OCPP gateway & connection handling · session state machine & persistence · reconciliation engine | **WF-03 Connection loss and reconciliation** |

Dependencies on other members: WP5 provides the simulator patch and billing consumer of reconciled sessions; WP3/WP4 consume the REST/realtime contracts (`openapi.json`) — not built yet (G1). Reviewer note: each file in `apps/csms/src/{ocpp-gateway,sessions,reconciliation}` carries a Vietnamese header explaining purpose and the ADR/STM it implements; AI assistance was used and is declared in `docs/BANG-KHAI-BAO-CONG-NGHE.md`.

---

## Appendix A — Defense 1.1 targets (WP2 part)

### Main workflow
| ID | Workflow | Actors | Business outcome | Features | Entity states | Owner |
|---|---|---|---|---|---|---|
| WF-03 | Connection loss and reconciliation | Pillar, CSMS, Operator | A session interrupted by a connection loss ends in a consistent energy figure or is escalated to an operator with evidence | OCPP connection · frame logging · replay detection · reconciliation · session lifecycle | ChargingSession: `active → orphaned → active/review → reconciled` | Trí |

### Demo scenarios (details and run status: `docs/DEMO-REVIEW-2.md`)
| ID | Workflow | Type | Precondition / data | Main steps | Expected result |
|---|---|---|---|---|---|
| DS-03a | WF-03 | Main | Pillar `RH24D1-00001` charging on gun A | Drop network 60 s → reconnect | Session `review`, conflict record, replayed samples flagged on the console |
| DS-03b | WF-03 | Exception | Session already exists | Re-send `StartTransaction` | No second session; original `transactionId` returned |
| DS-03c | WF-03 | Exception | Card not registered, pillar offline when swiped | Reconnect, replay `StartTransaction` | Session recorded and flagged unattributed/unknown tag, not dropped |
| DS-03d | WF-03 | Exception | Session `orphaned`, pillar still charging | Pillar reconnects and sends live MeterValues | Session returns `orphaned → active` |

### Test-case count (formula of guide §9.3) — WP2 share
| Source | Count | Basis |
|---|---|---|
| Mandatory features | 8 × 3 = **24** | table in Section 6 |
| Main workflows | 1 | WF-03 end-to-end |
| STM-1 transitions | **22** | each valid transition + rejected-pair sweep |
| STM-3 transitions | **8** | pillar lifecycle (`docs/XAC-NHAN-STATE-MACHINE-T13.md`) — to be written |
| NFRs | 6 | Section 7 |
| **Committed minimum (WP2)** | **61** | already automated today: 115 tests, of which ≥ 22 map to STM-1 |

Counts here cover WP2 only; the team total is the sum over members and must match the Commitment (BM04) exactly, with each test case counted for one person.
