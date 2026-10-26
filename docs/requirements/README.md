# Requirements in the repository

Markdown copies of the requirement documents, so code reviews, the BM02 self-review and the Review 2 council can check the code against what was promised. The Word files on the team Google Drive (Main Doc) stay the masters; these copies are refreshed when a master changes.

| File | Source | Date |
|---|---|---|
| `registration-form-v1.2.md` | `FA26SE187_Phieu-dang-ky_v1.2.docx` (accepted form; contact details removed) | 15/10/2026 |
| `report1-project-introduction.md` | `Report1_Project Introduction - PowerMe.docx` | 21/10/2026 |
| `report3-srs.md` | `Report3_Software Requirement Specification - PowerMe.docx` | 24/10/2026 |

Report 4 (Software Design Document) is not copied: it is built from the diagram sources in `diagrams/` and the code.

## FR → use case (form v1.2 §3.2c)

| FR | Actor | Requirement (short) | Use cases | Priority |
|---|---|---|---|---|
| FR-01, FR-02 | Driver | Register with consent; personal and vehicle profiles; account closure request | UC-ACC-01, UC-ACC-02, UC-ACC-03 | Must |
| FR-03, FR-21 | Driver | Live connector status with freshness; up to three suggested stations | UC-CHG-01, UC-CHG-07 | Must |
| FR-04 – FR-06 | Driver | Start/stop in four billing modes within credit; live progress; report a faulty pillar | UC-CHG-02 – UC-CHG-05 | Must |
| FR-07, FR-08 | Driver (Admin for exceptions) | VNPay top-up with VAT e-invoice; history, balance, e-invoices; Admin billing exceptions (refund, late payment, e-invoice retry) | UC-PAY-01, UC-PAY-02, **UC-ADM-08** | Must |
| FR-17 | Driver | Earn and redeem loyalty points | UC-PAY-03, UC-PAY-04 | Must |
| FR-09 | Operator | Onboard a pillar and receive its credential | UC-OPS-01 | Must |
| FR-10, FR-11 | Operator | Status, uptime, utilisation, alerts; remote start/stop/reset | UC-OPS-02 – UC-OPS-04 | Must |
| FR-12, FR-13 | Operator | Time-of-day tariffs and promotions; resolve unattributed / review sessions | UC-OPS-05 – UC-OPS-07 | Must |
| FR-14, FR-15 | Admin | Accounts, roles, permissions; device registry, RFID cards, free-vend tags | UC-ADM-01 – UC-ADM-05 | Must |
| FR-16 | Charging pillar | OCPP 1.6J central system; record every session; no double billing; reconcile after a connection loss | UC-INT-01 – UC-INT-04 | Must |
| FR-18 – FR-20 | Operator, Admin, Driver | Maintenance tickets, analytics; policy templates, platform health; reservation | UC-OPS-08/09, UC-ADM-06/07, UC-CHG-06 | Should |

UC-ADM-08 Handle Billing Exceptions was added on 24/10/2026 by the WF-02 design; it is the Admin side of the FR-07 top-up and e-invoice flow, so the form's FR list is unchanged. UC-ADM-08 and UC-ACC-02 (account closure) were added after the form was accepted; on 26/10/2026 they were decided to be a **scope change**, recorded in BM03 (BM02 run 2, F01).

## STM-1 ChargingSession: transition → UC / FR

The 22 transitions of `apps/csms/src/sessions/session-state-machine.ts` (diagram `diagrams/stm/STM-1_ChargingSession.puml`, v0.5).

| # | From → To | Event | Use case | FR |
|---|---|---|---|---|
| 1 | ● → pending | REMOTE_START_ACCEPTED | UC-CHG-02 | FR-04 |
| 2 | ● → active | START_TRANSACTION (started at the pillar) | UC-INT-02 | FR-16 |
| 3 | pending → active | START_TRANSACTION | UC-CHG-02 | FR-04 |
| 4 | pending → failed | START_TIMEOUT | UC-CHG-02 | FR-04 |
| 5 | active → paused | STATUS_SUSPENDED | UC-CHG-04 | FR-05 |
| 6 | paused → active | STATUS_CHARGING | UC-CHG-04 | FR-05 |
| 7 | active → stopping | STOP_REQUESTED (limit, credit cutoff, driver Stop) | UC-CHG-03 | FR-04, FR-05 |
| 8 | paused → stopping | STOP_REQUESTED | UC-CHG-03 | FR-04 |
| 9a | stopping → active | REMOTE_STOP_REJECTED | UC-CHG-03, UC-OPS-04 | FR-04, FR-11 |
| 9 | stopping → closed | STOP_TRANSACTION | UC-CHG-03 | FR-04 |
| 10 | active → closed | STOP_TRANSACTION (stopped at the pillar) | UC-INT-02 | FR-16 |
| 11 | paused → closed | STOP_TRANSACTION | UC-INT-02 | FR-16 |
| 12 | closed → reconciled | RECONCILE_OK | UC-INT-03, UC-PAY-02 | FR-16, FR-08 |
| 12a | closed → review | RECONCILE_CONFLICT | UC-INT-03, UC-OPS-05 | FR-16, FR-13 |
| 13 | active → orphaned | STATION_OFFLINE | UC-INT-03 | FR-16 |
| 14 | paused → orphaned | STATION_OFFLINE | UC-INT-03 | FR-16 |
| 15 | stopping → orphaned | STATION_OFFLINE | UC-INT-03 | FR-16 |
| 16 | orphaned → reconciled | RECONCILE_OK | UC-INT-03 | FR-16 |
| 16a | orphaned → review | RECONCILE_CONFLICT or HARD_CAP_EXCEEDED | UC-INT-03, UC-OPS-05 | FR-16, FR-13 |
| 17 | review → reconciled | OPERATOR_RESOLVED | UC-OPS-05 | FR-13 |
| 18 | orphaned → active | LIVE_MESSAGE | UC-INT-03 | FR-16 |
| 19 | reconciled → review | LATE_SAMPLE_CONFLICT | UC-INT-03, UC-OPS-05 | FR-16, FR-13 |
