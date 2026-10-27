# Capstone Project Register (registration form) v1.3

> Markdown copy of `FA26SE187_Phieu-dang-ky_v1.3.docx` (26/10/2026, **proposed final**, submitted at Review 2 with BM03 Record of Changes). Master file: team Google Drive (Main Doc). Phone numbers and e-mail addresses removed for the repository. Once the Review 2 council locks it, this is the source of truth for the committed scope (Must FR-01 to FR-17, FR-21). The accepted v1.2 stays in `registration-form-v1.2.md`.

*[figure — see `diagrams/`]*

**CAPSTONE PROJECT REGISTER**

**Class**: GFA26SE121 **Duration time**: from 09/2026 To 03/2027

**(\*) Profession:** Software Engineer **Specialty**: SE *[figure — see `diagrams/`]*

**(\*) Kinds of person make registers:** Lecturer *[figure — see `diagrams/`]* Students

**Record of Changes**

| **VERSION** | **DATE**                                  | **A\*, M, D** | **IN CHARGE**                                           | **CHANGE DESCRIPTION**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **REFERENCE**                                                                                                                                                                                                    |
|-------------|-------------------------------------------|---------------|---------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1.0         | 04/08/2026                                | A             | GVHD - Lâm Hữu Khánh Phương                             | Original registration approved by the University.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Topic assignment decision                                                                                                                                                                                        |
| 1.1         | 30/09/2026                                | M, D, A       | Ngô Văn Minh Trí (team leader); prepared by Trần Đức Ân | \(1\) §3.2c rewritten as a coded Must-have list FR-01 to FR-16 grouped by actor; reservation, MoMo/ZaloPay, loyalty, analytics, maintenance tickets, policy templates and the system-health dashboard moved out of the commitment (Should/Could). (2) §3.2d NFRs rewritten with measurable thresholds. (3) New §3.2h Out of scope. (4) OCPP scope fixed to 1.6J; 2.0.1 deferred. (5) §3.3 research baseline changed from the vendor cloud platform (not accessible) to the SteVe reference CSMS on an OCPP simulator. (6) Class code added. (7) Payment model changed to a prepaid Charging Credit (30/09): §3.2b, FR-04/05/07/08, §3.2e, §3.2f, §3.2h and §4 updated. (8) Should-level items (revenue analytics, system-health monitoring) marked as not committed in §3.2b, §3.2e and §3.2f; Admin Console product wording aligned with FR-14/FR-15.                                                                                                                                                                                                                                                                                                                                                                      | GVHD meeting 17/09/2026; Team Check-In 18/09/2026; supervisor guides 23-25/09/2026; payment-model decision 30/09/2026 (Report 3 §3.4)                                                                            |
| 1.2         | 06/10/2026 (revised 09/10 and 15/10/2026) | M, A          | Ngô Văn Minh Trí (team leader); prepared by Trần Đức Ân | \(1\) §3.2a-b reframed after Review 1: PowerMe is one shared, Vietnamese-localized platform that independent operators of imported OCPP pillars join. (2) Scope deepened rather than widened (supervisor's advice): live connector status with time left (FR-03), station suggestion (FR-21, new) and loyalty points (FR-17) are Must; uptime and utilisation added to FR-10, repeated fault reports to FR-06; FR-04, FR-08, FR-16 extended. (3) 09/10: on-demand reservation (FR-20) moved from Must to Should. (4) §3.2d: suggestion, status and time-left targets added. (5) §3.2e-g: map and routing service added; navigation and telematics out of scope. (6) 15/10: aligned with the Capstone Review Standardization Checklist (Out of scope moved into §3.2b; FRs grouped by actor; five NFR groups; stack named; tasks with outputs and milestones). (7) 15/10, §3.3: v1.0 compared with the vendor cloud, v1.1 with SteVe, v1.2 (06/10) made SteVe optional. Final: SteVe and a no-reconciliation baseline are committed in RQ1; RQ2 added for the already committed suggestion evaluation. Impact: Must 298 to about 309 of 325 man-days; actors, features and timeline unchanged. Approval: pending supervisor. | Review 1 feedback 01/10/2026; ADR-0014; Positioning decisions D1-D4; team meeting 09/10/2026 and ADR-0015; supervisor comment on the SteVe comparison and Capstone Review Standardization Checklist (15/10/2026) |
| 1.3         | 26/10/2026                                | A, M          | Ngô Văn Minh Trí (team leader); prepared by Trần Đức Ân | Proposed final version for Review 2 (details in BM03 rows 1-4). (1) §3.2c Admin: billing exceptions added as the Admin part of FR-07 (UC-ADM-08: refunds to the original source, late payments, e-invoice retry); §3.2b Admin Console wording follows. (2) §3.2c FR-01, FR-02: the driver requests account closure in the app (UC-ACC-02); the closure refund is no longer an Admin account action. (3) §3.2g: connector status and time-left estimation services moved from WP4 to WP2; WP4 keeps the station suggestion service and RQ2 runs. (4) §3.2g milestones: form finalised at Review 2. Impact: no FR added or removed; about 1.5 man-days added (one Admin screen, one app action), absorbed in the buffer; actors and timeline unchanged. Approval: pending Review 2 council. | WF-02 design 24/10/2026 (Report 3 Record of Changes 24/10; Report 4 STM-4, STM-5, STM-7); ADR-0013; team decision 26/10/2026; BM02 self-review run 2 F01, F28 |

*\*A - Added · M - Modified · D - Deleted*

**1. Register information for supervisor (if have)**

| No.        | Full name            | Phone | **E-Mail**           | **Title**  |
|------------|----------------------|-------|----------------------|------------|
| Supervisor | Lâm Hữu Khánh Phương |       | (removed) | Giảng viên |

**2. Register information for students (if have)**

| **No.** | **Full name**    | **Student code** | **Phone**  | **E-mail**                   | **Role in Group** |
|---------|------------------|------------------|------------|------------------------------|-------------------|
| 1       | Ngô Văn Minh Trí | SE191045         | (removed) | (removed)    | Leader            |
| 2       | Trần Đức Ân      | SE190747         | (removed) | (removed)     | Member            |
| 3       | Lê Bảo Khang     | SE190951         | (removed) | (removed)        | Member            |
| 4       | Lý Hoàng Sơn     | SE190998         | (removed) | (removed) | Member            |
| 5       | Trần Trọng Nghĩa | SE192191         | (removed) | (removed)             | Member            |

**3. Register content of Capstone Project**

**(\*) 3.1. Capstone Project name:**

3.1.1. English: ***<u>PowerMe: Smart EV Charging Network Management Platform</u>***

3.1.2. Vietnamese: ***<u>PowerMe: Nền tảng quản lý mạng lưới sạc xe điện thông minh</u>***

**Abbreviation: PowerMe**

**(\*) 3.2. Main proposal content (including result and product)**

**a) Context:**

Independent charging operators in Vietnam often import OCPP-compliant DC pillars from Chinese manufacturers (here called ChargeLink). The pillars come with the vendor's generic cloud and app. Three problems follow:

\- **P1. Vendor software does not fit Vietnamese operations:** no Vietnamese interface, local payment, VAT e-invoicing, operator tariffs or local fault monitoring.

\- **P2. Small operators cannot build their own stack:** a full CSMS, app and billing stack is too costly in-house, and joining a large closed network means giving up their tariffs and brand.

\- **P3. Drivers lack reliable charging information:** they need one app per network, are shown stations their vehicle cannot use, and cannot tell when a busy connector will be free.

Evidence: ChargeLink manuals and a review of seven Vietnamese charging apps (09/2026); a driver survey (at least 20 responses) and an operator interview before Review 2.

**b) Proposed Solutions:**

PowerMe is one shared platform with its own OCPP 1.6J CSMS: each operator manages only its own pillars and tariffs, and drivers use one app across all operators, paying from a prepaid Charging Credit.

\- **OCPP CSMS backend (P1, P2):** replaces the vendor cloud for status, transactions, metering and remote commands; reconciles session data after a disconnect.

\- **Status, estimation and suggestion services (P3):** connector status with freshness, time-left estimates and station suggestions ranked by time until charged or cost.

\- **Driver App (P3):** find, start, stop and pay for charging in Vietnamese; loyalty points.

\- **Operator Dashboard and Admin Console (P1, P2):** pillar onboarding, monitoring, uptime, tariffs; users, roles, registries and billing exceptions.

\- **Billing, Credit and Loyalty module (P1):** credit ledger, VNPay top-ups, VAT e-invoices, cross-operator points ledger.

**Main flows:** (1) find or get a suggested station, charge and pay from credit; (2) top up via VNPay and receive an e-invoice; (3) operator onboards a pillar that appears to drivers live; (4) a pillar disconnects and the CSMS reconciles the session.

**Out of scope:** hardware work (all tests use an OCPP 1.6J simulator); OCPP 2.0.1, ISO 15118; building a payment gateway, e-invoice provider or routing engine; an e-wallet (credit cannot be withdrawn or transferred, Decree 52/2024/ND-CP); RFID wallet-card top-up; VinFast network; in-app navigation; telematics.

**c) Functional Requirements:**

Must-have functions by actor; codes trace to the Report 3 Use Case List, and an FR is accepted when its use-case test scenarios pass end-to-end on the simulator.

\- **Driver (end user; own account, vehicles, sessions and credit only):**

> • **FR-01, FR-02** Register with consent to personal-data processing; manage personal and vehicle profiles; request account closure, allowed only when the balance is not negative and no top-up or session is open, with unused credit refunded to the original payment source (UC-ACC-01 to 03).
>
> • **FR-03, FR-21** Find stations with each connector's live status (Available, In use with time left as a range, Freeing soon, Unavailable, Offline) and last update; incompatible stations hidden by default. Get up to three suggestions ranked by time until charged (travel, wait, charging) or by arrival-tariff cost, within the entered battery range; unreliable stations ranked lower; hand-off to the phone's map (UC-CHG-01, 07).
>
> • **FR-04 to FR-06** Start and stop a session in one of four billing modes; it starts only if the credit covers the minimum and stops before credit runs out; view live energy, cost and credit; report a faulty pillar (repeated reports label it) (UC-CHG-02 to 05).
>
> • **FR-07, FR-08** Top up via VNPay with a VAT e-invoice per top-up; view history, balance and e-invoices (UC-PAY-01, 02).
>
> • **FR-17** Earn points on charging and redeem them at top-up; 12-month expiry, no cash value (UC-PAY-03, 04).

\- **Operator (business user; own pillars, sites, tariffs and data only):**

> • **FR-09** Onboard a pillar and receive its credential (UC-OPS-01).
>
> • **FR-10, FR-11** Monitor status, uptime, utilisation and faults with alerts; send remote start, stop, reset (UC-OPS-02 to 04).
>
> • **FR-12, FR-13** Set time-of-day tariffs and promotions; resolve unattributed sessions (UC-OPS-05 to 07).

\- **Admin (PowerMe staff; configuration, permissions, registries and billing exceptions; no charging operations):**

> • **FR-14, FR-15** Manage accounts, roles and permissions; device registry, RFID cards, free-vend tags (UC-ADM-01 to 05).
>
> • **FR-07 (Admin part)** Handle billing exceptions: refund a top-up made in error or a closed account's unused credit to its original source, refund a payment confirmed after the top-up expired, retry a failed e-invoice; every refund issues an adjustment invoice (UC-ADM-08).

\- **Charging pillar (external device, served by the CSMS module):**

> • **FR-16** OCPP 1.6J central-system role; record every session however started, never double-bill a pillar-paid session, reconcile data after a connection loss (UC-INT-01 to 04).

\- **Should / Could (not committed):**

> • **Should:** FR-18 maintenance tickets, revenue analytics; FR-19 policy templates, platform health; FR-20 on-demand reservation; membership tiers. Could: availability alert, queueing, MoMo/ZaloPay, OCPP 2.0.1.

**d) Non-Functional Requirements:**

\- **Interoperability:** OCPP 1.6J; 100% of the FR-16 message set passes the end-to-end suite on the simulator.

\- **Performance and capacity:** pillar message answered within 1 s; status change on dashboard within 3 s, on the map within 5 s; QR scan to session start within 10 s; suggestion within 2 s for 50 stations (all p95); 100 concurrent simulated pillars on 1 vCPU / 2 GB (k6).

\- **Reliability and accuracy:** 0 acknowledged transaction messages lost in the three disconnect scenarios; offline alert within 900 s; a connector silent for two heartbeat intervals shown as out of date; the mid-session time-left range contains the actual end in at least 70% of simulated sessions.

\- **Security and data protection:** TLS with per-pillar credentials (Security Profile 2); every endpoint enforces role-based access, tested per role; operators see only their own data; processing only after consent; billing records kept 10 years.

\- **Localization, compliance and usability:** all app screens in Vietnamese, VND; e-invoice fields per Decree 123/2020/ND-CP, Circular 78/2021/TT-BTC, Decree 70/2025/ND-CP; registration in at most 3 screens.

**e) Theory & Practical:**

**Theory**

\- **OCPP 1.6J and CSMS architecture:** charge-point state machine, transaction lifecycle, idempotent handling, duplicate and gap detection over unreliable links.

\- **Wait-time estimation and ranking:** remaining time from session limits, a DC charging-curve model or pillar history; ranking by time, cost and reliability.

\- **Multi-tenant platforms and ledgers:** per-operator data isolation, role-based access, Vietnamese e-invoicing, points expiry and reversal.

**Practical**

\- **Stack:** NestJS (TypeScript) with ocpp-rpc; PostgreSQL with Drizzle ORM; Redis; Flutter app; React dashboard; Docker Compose on a staging VPS.

\- **Dependencies and fallback:** no physical pillar is available, so an OCPP 1.6J simulator stands in; VNPay, e-invoice and routing (Goong or Google Distance Matrix) run in sandbox or free tier.

\- **Testing:** unit and integration tests, OCPP end-to-end suite, disconnect harness, k6 load tests, per-role authorisation tests.

**f) Products (Expected Deliverables):**

\- **Source code** of the five components in 3.2b (Git repository).

\- **Deployed demo** on a staging server driven by the simulator, with an acceptance script for the four main flows.

\- **Documents and test reports:** Reports 1 to 7, with unit, integration, OCPP end-to-end, load and authorisation results in Report 5.

\- **Research package:** scripts, scenario configurations, raw logs and analysis for RQ1 and RQ2; results in Report 7.

**g) Proposed Tasks:**

One owner per work package (WBS and effort in Report 2). Order: WP1 specification, WP2 OCPP core, then WP3 to WP5 integration; experiments start after the CSMS passes the disconnect harness.

\- **WP1 Management and research (Trần Đức Ân):** requirements, architecture, survey, experiment protocol, research write-up. Output: Reports 1 to 4 and 7, protocol.

\- **WP2 OCPP CSMS (Ngô Văn Minh Trí):** central-system role, reconciliation, connector status and time-left estimation services; SteVe set-up and RQ1 runs. Output: CSMS API with status and estimate endpoints, OCPP test suite, RQ1 logs.

\- **WP3 Driver App (Lý Hoàng Sơn):** driver screens and VNPay top-up. Output: app build, UI test cases.

\- **WP4 Dashboard and suggestion service (Trần Trọng Nghĩa):** operator and admin web, including the Admin billing-exceptions screen; station suggestion service built on the CSMS status and estimate API. Output: web app, suggestion API, RQ2 logs.

\- **WP5 Billing, loyalty and QA (Lê Bảo Khang):** credit, e-invoice and loyalty ledgers; test strategy and harness. Output: billing module, Report 5.

**Milestones:** form v1.2 accepted 15/10; final form locked at Review 2 (26/10 to 08/11); full package 06/12; defense 14 to 20/12/2026.

**3.3. Research Information**

**a. Research Problem / Research Question**

A CSMS bills from transaction and meter messages sent over WebSocket. After a disconnect the pillar resends queued messages, so the server may see duplicates, late data or sessions it never saw start. OCPP 1.6J does not define how the server reconciles them, and the OCPP studies found so far address security and station integration, not measured billing-data integrity.

**RQ1:** How do energy error, duplicate and lost transactions, and gap-detection precision and recall differ between PowerMe's CSMS, the same CSMS without reconciliation, and SteVe, under three controlled disconnect scenarios?

**RQ2:** Does ranking stations by expected time until charged reduce simulated total time until charged compared with nearest-station ranking, under idle, mixed and busy load?

**Hypotheses:** H1: with reconciliation, PowerMe loses no acknowledged transaction and has lower energy error than both baselines. H2: time-based ranking lowers mean total time under busy load and is no worse when idle.

**b. Research Objectives**

\- O1: measure billing-data integrity of a self-built OCPP 1.6J CSMS under disconnects.

\- O2: isolate the effect of the reconciliation logic against a no-reconciliation baseline and SteVe.

\- O3: measure the time saved by time-based station ranking over nearest-station ranking.

**c. Research Scope & Methodology**

\- **RQ1:** disconnects during meter reporting, just before StopTransaction, and during an offline-started session; the three systems get the same simulator scripts and server resources; ground truth is the simulator's log of delivered energy and transactions; 30 runs per scenario with fixed seeds, reporting mean and 95% confidence interval.

\- **RQ2:** 50 simulated stations, same scenarios and seeds for both rankings; metric: total time until charged (minutes). No model is trained, so no data split; estimator thresholds are fixed before evaluation.

\- **Reproducibility:** scripts, seeds, versions and logs kept in the repository; a one-scenario pilot runs once the OCPP core passes the harness.

**d. Expected Scientific Contribution**

OCPP 1.6J and SteVe exist; PowerMe adds a reconciliation method in a multi-operator CSMS. The contribution is measured billing-data integrity against two baselines and a measured comparison of suggestion strategies, reported whichever way results fall; simulator-only testing and synthetic load are stated as threats to validity.

**e. Related Works / Literature Review (Preliminary)**

\- Open Charge Alliance, OCPP 1.6 Edition 2, 2017; SteVe open-source OCPP central system, RWTH Aachen (RQ1 baseline).

\- C. Alcaraz, J. Lopez, S. Wolthusen, "OCPP Protocol: Security Threats and Challenges," IEEE Trans. Smart Grid, vol. 8, 2017.

\- M. S. Hadi et al., "Off-Grid EV Charging Station with Integrated Local Server OCPP Protocol as a Management System," Transport and Telecommunication Journal, 25(3), 2024.

\- S. Schoenberg, F. Dressler, "Reducing Waiting Times at Charging Stations with Adaptive Electric Vehicle Route Planning," IEEE Trans. Intelligent Vehicles, 8(1), 2023 (RQ2).

**4. Other comments (propose all relative things if have):**

Risks: simulator only, third-party sandboxes, capacity (Must about 309 of 325 man-days; Should items are the buffer). To confirm with the supervisor: the three v1.3 changes in BM03; whether the deeper scope answers Review 1; sandbox services for the final submission; the Charging Credit without an e-wallet licence; 4 pages because of the research section.

<table>
<colgroup>
<col style="width: 43%" />
<col style="width: 56%" />
</colgroup>
<thead>
<tr class="header">
<th><p><strong>Supervisor (If have)</strong></p>
<p><em>(Sign and full name)</em></p></th>
<th><p>HCM, date 26/10/2026</p>
<p><strong>On behalf of Registers</strong></p>
<p><em>(Sign and full name)</em></p></th>
</tr>
</thead>
<tbody>
</tbody>
</table>
