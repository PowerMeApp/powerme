# Diagrams

Every figure of **Report 3 (SRS)** and **Report 4 (SDD)**, redrawn on 30/10–02/11/2026 after Review 2 to follow the lecturer guides (overview level, one diagram per page, English only, "Charge Point" as the single device term). This replaces the earlier `ad/ arch/ erd/ report3/ stm/ team/ wf02/ wf05/` sources.

Each diagram has its own folder with the **source** and a **PNG render** (open the PNG on GitHub to see it). Master copies: `H:\Class\PowerMe\Fixed diagrams\` (WP1) and the team Drive.

## How to re-render

| Source type | Diagrams | Command |
|---|---|---|
| PlantUML `.puml` (+ shared `_style.iuml`) | AD, PKG, CD, SD, STM | `java -DPLANTUML_LIMIT_SIZE=16384 -jar plantuml-1.2024.7.jar -tpng <file>.puml` (needs Graphviz) |
| Python layout script `.py` | BCD, UCD, Screen Flow, ARCH-1, AD-4 | `python3 <script>.py` → SVG, then `rsvg-convert`. UCD scripts import the helper `vpuc` (`use-case/vpuc.py`) and screen flows import `sfdraw` (`screen-flow/driver/`): run from the figure folder with `PYTHONPATH=..` (UCD) or `PYTHONPATH=../driver` (screen flows); needs Pillow + DejaVu Sans. `vpuc` was rebuilt on 07/11/2026 from the committed UCD PNGs (same size, ~1 % anti-aliasing difference); the committed PNGs stay the reference |
| draw.io `.drawio` | ARCH-2, Logical ERD v1.1 (Refund) | open in diagrams.net or the VS Code Draw.io extension |
| ELK layout (`report4/erd-layout/`) | Conceptual, Logical, Physical ERD | `sh build_all.sh` (needs node + `elkjs@0.9.3`, Pillow, `rsvg-convert`); data in `model.py` + `pmodel.json` |
| DBML | Physical ERD | `report4/erd-physical/powerme_physical.dbml` → paste into dbdiagram.io |

## Report 3 — `report3/`

| Figure | Diagram | Folder |
|---|---|---|
| BCD-1 | Business Context Diagram — PowerMe Platform | `bcd/` |
| UCD | Use case diagram — Driver | `use-case/driver/` |
| UCD | Use case diagram — Operator | `use-case/operator/` |
| UCD | Use case diagram — Admin | `use-case/admin/` |
| UCD | Use case diagram — Charge Point (OCPP) | `use-case/charge-point/` |
| SF | Screen flow — Driver App | `screen-flow/driver/` |
| SF | Screen flow — Operator Dashboard | `screen-flow/operator/` |
| SF | Screen flow — Admin Console | `screen-flow/admin/` |
| AD-1 | Charge a vehicle with the Driver App | `activity/AD-1/` |
| AD-2 | Top up Charging Credit (optional points redemption) | `activity/AD-2/` |
| AD-3 | Charge Point loses connection during a session, then reconcile | `activity/AD-3/` |
| AD-4 | Reserve a charging connector (Should) | `activity/AD-4/` |
| AD-5 | Get station suggestion | `activity/AD-5/` |
| AD-6 | Session started at the Charge Point (RFID, password, free vend) | `activity/AD-6/` |
| AD-7 | Charge Point fault: report, alert, remote reset | `activity/AD-7/` |
| AD-8 | Onboard a Charge Point and first connection | `activity/AD-8/` |
| AD-9 | Handle billing exceptions: refunds and e-invoice retry | `activity/AD-9/` |
| CERD | Conceptual ERD (v1.1, incl. Refund R8) | `erd-conceptual/` |

> AD numbers changed in the redraw: old AD-2 (charge point offline) is now **AD-3**, old AD-3 (top-up) is now **AD-2**; AD-9 is new.

## Report 4 — `report4/`

| Figure | Diagram | Folder |
|---|---|---|
| ARCH-1 | Component / container view of the PowerMe Platform | `architecture/ARCH-1/` |
| ARCH-2 | System architecture (deployment, AWS-style) | `architecture/ARCH-2/` |
| PKG-1 | Package diagram — CSMS back end (`apps/csms`) | `package/PKG-1/` |
| PKG-2 | Package diagram — Operator Dashboard and Admin Console (`apps/dashboard`) | `package/PKG-2/` |
| PKG-3 | Package diagram — Driver App (`apps/mobile`) | `package/PKG-3/` |
| CD-1 | Class — WF-01 find a station and charge (Driver App) | `class/CD-1/` |
| CD-2 | Class — WF-02 top-up, payment, e-invoice, refunds | `class/CD-2/` |
| CD-3 | Class — WF-03 lost connection, replay, reconciliation | `class/CD-3/` |
| CD-4 | Class — WF-04 Charge Point fault, alert, remote reset | `class/CD-4/` |
| CD-5 | Class — WF-05 register, onboard, connect a Charge Point | `class/CD-5/` |
| SD-1a / 1b | WF-01: find a station and charge; app-started session stops and is settled | `sequence/SD-1a/`, `SD-1b/` |
| SD-2a … 2f | WF-02: create top-up; payment notification; e-invoice; timeout and late payment; admin refund; account closure | `sequence/SD-2a/` … `SD-2f/` |
| SD-3a / 3b | WF-03: lost connection and reconcile; replayed StartTransaction recorded once | `sequence/SD-3a/`, `SD-3b/` |
| SD-4a / 4b | WF-04: fault, acknowledge, remote reset; driver report, reset fails, on-site fix | `sequence/SD-4a/`, `SD-4b/` |
| SD-5a / 5b | WF-05: register and onboard; first connection | `sequence/SD-5a/`, `SD-5b/` |
| SD-6 | Session started at the Charge Point with an RFID card | `sequence/SD-6/` |
| STM-1 … 10 | ChargingSession, Connector, Charge Point, TopUp, CreditAccount, FaultEvent, EInvoice, RfidCard, Reservation (Should), Refund | `state/STM-1/` … `STM-10/` |
| LERD | Logical ERD v1.1 (one diagram) | `erd-logical/` |
| PERD | Physical ERD v1.1 (real table names, one page) + DBML | `erd-physical/` |

## Owners

WP1 (Ân) redrew every diagram in one style; content owners confirm their own: WF-01 / PKG-3 Sơn, WF-02 / STM-4, 5, 7, 10 Khang, WF-03 / PKG-1 Trí, WF-04 / PKG-2 Nghĩa, WF-05 Ân. Edit the source in this folder (not only the PNG) and re-render in the same PR.

## Known differences between the diagrams and the code (carried over)

> Carried over unchanged from the pre-redraw README (checked against `main` up to migration `0003`). Diagram names in this table are the **old** ones: LERD-1/2 are now the single Logical ERD, WF-0x class/sequence are now CD-x / SD-xx, the device is called "Charge Point" throughout. Re-check each row against the redrawn set and close or update it.

Checked against `main` after migration `0001_quyet-dinh-be-11.sql` (PR #36, 25/10/2026). Rows 1–7 were first found at tag `review-2`.

Declared here so the BM02 self-review and reviewers see them; each has an owner.

| No | Diagram | Difference | Owner / task |
|---|---|---|---|
| 1 | STM-1 | ~~Code moves a session to `orphaned` as soon as the socket closes; ADR-0016 adds an offline grace period first~~ **Resolved 26/10/2026 by T61 (BE-12):** `OfflineGraceService` waits `OFFLINE_GRACE_S` (default 120 s since 27/10/2026, decided by WP1 in ADR-0016; was a 30 s placeholder; `0` = old behaviour) and orphans only if the charge point has no newer epoch in the DB; a startup sweep rebuilds lost timers. Residual: in-process timer instead of a BullMQ delayed job (no Redis yet) | Trí, T61 (done) |
| 2 | STM-3 | ~~`charge_points.lifecycle` still has `offline`; ADR-0016 moves connectivity to separate attributes. `ConnectionRegistry.open()` sets `in_service` unconditionally, so a future `disabled` charge point would be re-enabled on reconnect~~ **Resolved 26/10/2026 by T61 (BE-12), migration 0002:** connectivity is `charge_points.is_online` + `online_changed_at` (`last_message_at` = `last_seen_at`); `open()` only moves `awaiting_connection → in_service`, `close()` never touches `lifecycle`. The enum value `offline` stays in Postgres as **legacy** (cannot be dropped safely), is no longer written, and old rows were backfilled to `in_service` | Trí, T61 (done) |

| 3 | LERD-1 v0.4 | ~~Billing attributes (top-up expiry, late payment, refund, e-invoice error fields, account closure) are not in migrations `0000`/`0001` yet; loyalty types are `earn/redeem/expire/adjust` in the migration vs `earned/redeemed/restored/expired` in the ERD~~ **Resolved 27/10/2026 by T73, migration `0003_billing-wf02`:** every LERD-1 v0.4 attribute of TopUp, EInvoice and CreditAccount is a column (`expires_at`, `points_redeemed`, `gateway_transaction_no`, `refunded_at`/`refunded_by`, `late_*`, `last_error_*`/`last_attempt_at`, `closed_at`, `closure_refunded_at`); `gateway_reference` is our `vnp_TxnRef` (NOT NULL), `vnp_TransactionNo` is `gateway_transaction_no`; ledger uniqueness is `(top_up_id, transaction_type)`. Loyalty types: decided 26/10/2026 to keep `earn/redeem/expire/adjust` and add `restore` (`adjust` covers reversals, BR-P37); the names `earned/redeemed/restored/expired` are not used. AD-1 (and AD-3) were changed to `[earn]` by PR #51 (85834c3). CD-2 uses the same names since PR #47 (5d3cdff) | Khang, Trí (T73 done) |
| 4 | WF-04 sequences | `remote_commands` is now in migration `0001` and matches LERD-2 v0.3. **Partly resolved 27/10/2026 by FE-04 (Iteration 1 WF-04):** `FaultService` (STM-6) and the console Reset write and update `remote_commands` (pending → sent → accepted/rejected/failed/timeout); `fault_events.reset_command_id` added in migration `0008`. Residual: the Reset CALL is sent from the console, not from a `RemoteCommandService` (general BE-04 still open); driver report, tickets, hide connector, 900 s alert and realtime events not built (`docs/ITERATION-1-WF04.md` §8) | Trí, Nghĩa |

| 5 | WF-03 class | Event names in the diagram (START_ACCEPTED, STOP_RECEIVED, FAILED) are the 23/10 draft; the code uses the T13 names (START_TRANSACTION, STOP_TRANSACTION, START_TIMEOUT, …); STM-1 v0.5 follows the code. **Resolved:** the WF-03 diagram events were synchronised with the code in PR #39 | Trí (done) |
| 6 | WF-01 class | ~~The app's `SessionState` has no `reconciled`, `orphaned`, `review` or `failed`~~ **Resolved in the diagram 25/10/2026 (WF-01 class v1.1, Sơn):** `SessionState` lists all nine STM-1 values plus a client-only `unknown`. Residual: the app code on branch `wp3/mb-04-t31-luong-sac-wf01` still uses connector-style values (`preparing`, `charging`, `suspendedEv`, …) and different class names; align the code with the diagram in the T72 rework | Sơn |
| 7 | CD-5 | `ChargePointController` (HTTP endpoints) is planned; the service layer and the connection check are in code (PR #33) | Ân |
| 8 | PKG-1, ARCH-1, ARCH-2 | **Resolved 26/10/2026 (BM02 F32, F33):** PKG-1 arrows between `ocpp-gateway`, `stations`, `sessions`, `reconciliation` and `console` now follow the imports in code (gateway imports sessions, reconciliation, stations; sessions calls reconciliation, not the reverse); ARCH-1 v1.2 adds the operator console, the D1 HMI simulator and the demo runner; ARCH-2 v1.2 is drawn from `infra/staging` (no Redis) plus the local demo. Residual: `users`, `billing`, `tariffs`, `realtime`, `suggestions`, Redis are still target design in all three (BM02 F31); the staging layout has not run on a VPS yet | Trí |
