# Diagram sources

PlantUML (and one Graphviz) sources for every diagram in Report 3 and Report 4. All text is in English. Render with PlantUML 1.2024.7 and Graphviz:

```bash
java -DPLANTUML_LIMIT_SIZE=16384 -jar plantuml-1.2024.7.jar -tpng -o ../png <folder>/*.puml
dot -Tpng report3/Fig01_Business-Context-Diagram.dot -o png/fig01_bcd.png
```

| Folder | Diagrams | Owner | Used in |
|---|---|---|---|
| `report3/` | Fig 1 Business Context, Fig 2 UCD level 0, Fig 3–8 UCD level 1 (ACC, CHG, PAY, OPS, ADM incl. UC-ADM-08, INT), Fig 9–11 screen flows (Fig 11 incl. Billing Exceptions), Fig 12a/12b conceptual ERD | WP1 | Report 3 |
| `ad/` | AD-1 … AD-8 activity diagrams (AD-4 reservation is Should) | WP1 | Report 3, Report 4 §3.1.1 |
| `arch/` | ARCH-1 component, ARCH-2 deployment (staging) | WP1 | Report 4 §1.1 |
| `stm/` | STM-1 … STM-8 state machines (STM-4/5/7 confirmed by Khang) | WP1, owners confirm | Report 4 §3.1.2 |
| `erd/` | LERD-1 v0.4 (Charging & Billing), LERD-2 v0.3 (Operations & Administration), aligned with migration `0001` on 25/10 | WP1, WP5 | Report 4 §2 |
| `wf05/` | CD-5 class, SD-5a onboard, SD-5b first connection | WP1 (Ân) | Report 4 §3.6 |
| `team/` | PKG-1 CSMS and WF-03 class + 2 sequences (Trí), PKG-2 dashboard and WF-04 class + 2 sequences (Nghĩa), PKG-3 driver app and WF-01 class + sequence (Sơn): redrawn in one style, content unchanged | WP2, WP3, WP4 | Report 4 §1.2, §3.2, §3.4, §3.5 |

WF-02 (CD-2, SD-2a, SD-2b, SD-2c) sources are kept by Lê Bảo Khang (WP5) and will be added in `wf02/` by him.

## Known differences between the diagrams and the code

Checked against `main` after migration `0001_quyet-dinh-be-11.sql` (PR #36, 25/10/2026). Rows 1–7 were first found at tag `review-2`.

Declared here so the BM02 self-review and reviewers see them; each has an owner.

| No | Diagram | Difference | Owner / task |
|---|---|---|---|
| 1 | STM-1 | ~~Code moves a session to `orphaned` as soon as the socket closes; ADR-0016 adds an offline grace period first~~ **Resolved 26/10/2026 by T61 (BE-12):** `OfflineGraceService` waits `OFFLINE_GRACE_S` (default 120 s since 27/10/2026, decided by WP1 in ADR-0016; was a 30 s placeholder; `0` = old behaviour) and orphans only if the pillar has no newer epoch in the DB; a startup sweep rebuilds lost timers. Residual: in-process timer instead of a BullMQ delayed job (no Redis yet) | Trí, T61 (done) |
| 2 | STM-3 | ~~`charge_points.lifecycle` still has `offline`; ADR-0016 moves connectivity to separate attributes. `ConnectionRegistry.open()` sets `in_service` unconditionally, so a future `disabled` pillar would be re-enabled on reconnect~~ **Resolved 26/10/2026 by T61 (BE-12), migration 0002:** connectivity is `charge_points.is_online` + `online_changed_at` (`last_message_at` = `last_seen_at`); `open()` only moves `awaiting_connection → in_service`, `close()` never touches `lifecycle`. The enum value `offline` stays in Postgres as **legacy** (cannot be dropped safely), is no longer written, and old rows were backfilled to `in_service` | Trí, T61 (done) |
| 3 | LERD-1 v0.4 | ~~Billing attributes (top-up expiry, late payment, refund, e-invoice error fields, account closure) are not in migrations `0000`/`0001` yet; loyalty types are `earn/redeem/expire/adjust` in the migration vs `earned/redeemed/restored/expired` in the ERD~~ **Resolved 27/10/2026 by T73, migration `0003_billing-wf02`:** every LERD-1 v0.4 attribute of TopUp, EInvoice and CreditAccount is a column (`expires_at`, `points_redeemed`, `gateway_transaction_no`, `refunded_at`/`refunded_by`, `late_*`, `last_error_*`/`last_attempt_at`, `closed_at`, `closure_refunded_at`); `gateway_reference` is our `vnp_TxnRef` (NOT NULL), `vnp_TransactionNo` is `gateway_transaction_no`; ledger uniqueness is `(top_up_id, transaction_type)`. Loyalty types: decided 26/10/2026 to keep `earn/redeem/expire/adjust` and add `restore` (`adjust` covers reversals, BR-P37); the names `earned/redeemed/restored/expired` are not used. Residual: CD-2 (PR #47) and AD-1 still show the `earned…` names | Khang, Trí (T73 done) |
| 4 | WF-04 sequences | `remote_commands` is now in migration `0001` and matches LERD-2 v0.3. **Partly resolved 27/10/2026 by FE-04 (Iteration 1 WF-04):** `FaultService` (STM-6) and the console Reset write and update `remote_commands` (pending → sent → accepted/rejected/failed/timeout); `fault_events.reset_command_id` added in migration `0007`. Residual: the Reset CALL is sent from the console, not from a `RemoteCommandService` (general BE-04 still open); driver report, tickets, hide connector, 900 s alert and realtime events not built (`docs/ITERATION-1-WF04.md` §8) | Trí, Nghĩa |
| 5 | WF-03 class | Event names in the diagram (START_ACCEPTED, STOP_RECEIVED, FAILED) are the 23/10 draft; the code uses the T13 names (START_TRANSACTION, STOP_TRANSACTION, START_TIMEOUT, …); STM-1 v0.5 follows the code. **Resolved:** the WF-03 diagram events were synchronised with the code in PR #39 | Trí (done) |
| 6 | WF-01 class | The app's `SessionState` has no `reconciled`, `orphaned`, `review` or `failed` (it maps them to `unknown`/settlement); align with STM-1 before the app talks to the CSMS | Sơn |
| 7 | CD-5 | `PillarController` (HTTP endpoints) is planned; the service layer and the connection check are in code (PR #33) | Ân |
| 8 | PKG-1, ARCH-1, ARCH-2 | **Resolved 26/10/2026 (BM02 F32, F33):** PKG-1 arrows between `ocpp-gateway`, `stations`, `sessions`, `reconciliation` and `console` now follow the imports in code (gateway imports sessions, reconciliation, stations; sessions calls reconciliation, not the reverse); ARCH-1 v1.2 adds the operator console, the D1 HMI simulator and the demo runner; ARCH-2 v1.2 is drawn from `infra/staging` (no Redis) plus the local demo. Residual: `users`, `billing`, `tariffs`, `realtime`, `suggestions`, Redis are still target design in all three (BM02 F31); the staging layout has not run on a VPS yet | Trí |
