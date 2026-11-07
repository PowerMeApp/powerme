# Report 1 — Project Introduction

> Markdown copy of `Report1_Project Introduction - PowerMe.docx` (21/10/2026). Master file: team Google Drive (Main Doc). E-mail addresses removed for the repository; figures omitted.

*[figure — see `diagrams/`]*

**Capstone Project Report**

**Report 1 – Project Introduction**

> – Ho Chi Minh City, October 2026 –

# **Table of Contents**

[I. Record of Changes](#i.-record-of-changes)

[II. Project Introduction](#ii.-project-introduction)

[1. Overview](#overview)

[1.1 Project Information](#project-information)

[1.2 Project Team](#project-team)

[2. Product Background](#product-background)

[3. Existing Systems](#existing-systems)

[3.1 VinFast app (official OEM app)](#vinfast-app-official-oem-app)

[3.2 Trạm Sạc EV (EVCS JSC) and EV HUB / Trạm EV (Aydada)](#trạm-sạc-ev-evcs-jsc-and-ev-hub-trạm-ev-aydada)

[3.3 EBOOST](#eboost)

[3.4 VETC](#vetc)

[3.5 ChargeLink Vietnam, Google Maps, PlugShare](#chargelink-vietnam-google-maps-plugshare)

[4. Business Opportunity](#business-opportunity)

[3.6 Related Research](#chargelink-vietnam-google-maps-plugshare)

[Besides the apps above, the research question (how reliably a self-built CSMS reconciles billing data after a disconnect) was checked against published work. The registration form already cites the OCPP 1.6 specification, the SteVe open-source central system, Alcaraz et al. (2017) on OCPP security, Hadi et al. (2024) on a local OCPP management server, and Schoenberg and Dressler (2023) on reducing waiting times at charging stations. Four further sources were checked on 21/10/2026:](#business-opportunity)

- **Priyasta et al. (2023), Journal Européen des Systèmes Automatisés 56(1), doi:10.18280/jesa.560116: a message-conformance test tool for OCPP 1.6 central systems; applied to SteVe, it passed all positive scenarios but only about a third of the malformed-message scenarios. It tests single messages, not billing-data integrity across a disconnect.**

- **Open Charge Alliance (2024), "Improving Uptime Monitoring with OCPP", white paper v1.2: during a disconnect the charge point keeps charging, buffers transaction messages and sends them after reconnection so the session can still be invoiced. How the server reconciles late, duplicated or partial messages is left to the CSMS.**

- **Alcaraz, Cumplido and Triviño-Cabrera (2023), International Journal of Information Security, doi:10.1007/s10207-023-00698-8: STRIDE/DREAD threat analysis of OCPP 2.0.1. It addresses channel security, not data correctness after a connection loss.**

- **Rempel et al. (2023), Human Factors, doi:10.1177/00187208231215242: of 655 public DC fast-charger ports surveyed, about 27% were not functional. This supports ranking stations by reliability and showing reported issues to drivers.**

[Gap: no study found so far measures the billing-data integrity of a CSMS (energy error, duplicate and lost transactions, gap detection) under controlled disconnects. PowerMe measures it against two baselines (RQ1) and measures whether time-based station ranking beats nearest-station ranking (RQ2).](#business-opportunity)

[5. Software Product Vision](#software-product-vision)

[6. Project Scope & Limitations](#project-scope-limitations)

[6.1 Major Features](#major-features-committed-must)

[6.2 Limitations & Exclusions](#limitations-exclusions)

# I. Record of Changes

<table>
<colgroup>
<col style="width: 11%" />
<col style="width: 9%" />
<col style="width: 14%" />
<col style="width: 65%" />
</colgroup>
<tbody>
<tr class="odd">
<td>Date</td>
<td>A*<br />
M, D</td>
<td>In charge</td>
<td>Change Description</td>
</tr>
<tr class="even">
<td>16/09/2026</td>
<td>A</td>
<td>Trần Đức Ân (WP1)</td>
<td>Initial draft assembled from Project Charter v2, Competitor App Analysis &amp; VinFast Filter Recommendation, Project Context Primer, and the capstone registration form (Phieu_FA26SE187) — for team review.</td>
</tr>
<tr class="odd">
<td>16/09/2026</td>
<td>M</td>
<td>Trần Đức Ân (WP1)</td>
<td>Group/class code GFA26SE121 confirmed and filled in.</td>
</tr>
<tr class="even">
<td>18/09/2026</td>
<td>M</td>
<td>Trần Đức Ân (WP1)</td>
<td>Revised after the supervisor meeting of 17/09/2026 and the Team Check-In: §6 Major Features now list only committed (Core) scope, with Target/Stretch items moved to §6.2 as explicit non-commitments, per the supervisor’s grading criterion (delivered vs. promised); added FE-10 session classification / no double billing; pillar reservation moved to Stretch (team decision); LI-4 updated (no vendor channel; standard-station assumptions).</td>
</tr>
<tr class="odd">
<td>26/09/2026</td>
<td>M</td>
<td>Trần Đức Ân (WP1)</td>
<td>Aligned with the registration form v1.1 and the revised SRS: scope wording uses MoSCoW (Must / Should / Could); each §6.1 feature traced to FR-01–FR-16; FE-10 (staging environment) removed as it is infrastructure, not a product feature (kept in Report 2 §6.3); LI-2/LI-3 relabelled Should/Could.</td>
</tr>
<tr class="even">
<td>30/09/2026</td>
<td>M</td>
<td>Trần Đức Ân (WP1)</td>
<td>Payment model changed to a prepaid Charging Credit (Report 3 §3.4, ADR-0013): FE-01, FE-06 and FE-07 reworded (top-up through VNPay, sessions paid from the credit, e-invoice at top-up); LI-4 states that the credit is not an e-wallet.</td>
</tr>
<tr class="odd">
<td>06/10/2026</td>
<td>M</td>
<td>Trần Đức Ân (WP1)</td>
<td>Revised after Review 1 (01/10/2026), aligned with registration form v1.2: PowerMe repositioned as one shared platform for independent operators of imported OCPP pillars, with drivers getting every partner operator's pillars in one app (§2, §4, §5 rewritten; positioning statement added); FE-10 on-demand reservation, FE-11 live connector status and station suggestion, and FE-12 loyalty points added as Must (ADR-0014); FE-01, FE-03, FE-04 and FE-05 extended (reconciliation measurement now Must); LI-2 and LI-3 re-tiered; LI-6 added (navigation, telematics, routing engine); primary-evidence survey noted in §4.</td>
</tr>
<tr class="even">
<td>09/10/2026</td>
<td>M</td>
<td>Trần Đức Ân (WP1)</td>
<td>Revised after the team meeting of 09/10/2026, aligned with the revised registration form v1.2 (ADR-0015): on-demand reservation moved from Must to Should (enforcement and fee rules need more design) — FE-10 now covers pillar reliability signals; FE-11 deepened (driver-facing status with freshness, time-left estimate with fallbacks, suggestion ranked by expected time until charged or by cost, measured against baselines); FE-01, FE-03 and FE-05 updated; LI-2 and LI-3 updated; §2, §4 and §5 no longer promise a held connector.</td>
</tr>
<tr class="odd">
<td>21/10/2026</td>
<td>M, A</td>
<td>Trần Đức Ân (WP1)</td>
<td>Aligned with the accepted registration form v1.2 (15/10/2026): §6 FR range corrected (FR-18–FR-20 are Should); FE-04 commits the comparison with a no-reconciliation baseline and the SteVe reference CSMS (RQ1); FE-11 names RQ2; SteVe removed from LI-2; §3.6 Related research added (sources checked 21/10/2026); §4 primary-evidence status updated.</td>
</tr>
</tbody>
</table>

\*A - Added M - Modified D - Deleted

# II. Project Introduction

## 1. Overview

### 1.1 Project Information

- **Project name:** PowerMe — Smart EV Charging Network Management Platform (VN: Nền tảng quản lý mạng lưới sạc xe điện thông minh)

- **Project code:** FA26SE187

- **Group name / class code:** GFA26SE121

- **Software type:** Multi-platform — mobile app (Driver App, Flutter), web app (Operator Dashboard & Admin Console, React), and backend service (OCPP 1.6J CSMS, NestJS/Node.js)

### 1.2 Project Team

| **Full Name**            | **Student Code** | **Role**    | **Email**                    | **Work Package**                            |
|--------------------------|------------------|-------------|------------------------------|---------------------------------------------|
| **Lâm Hữu Khánh Phương** | —                | Supervisor  | (removed)         | —                                           |
| **Ngô Văn Minh Trí**     | SE191045         | Team Leader | (removed)    | WP2 — OCPP CSMS & Hardware Integration      |
| Trần Đức Ân              | SE190747         | Member      | (removed)     | WP1 — Project Management & Business Analyst |
| Lý Hoàng Sơn             | SE190998         | Member      | (removed) | WP3 — Driver App & Payments                 |
| Trần Trọng Nghĩa         | SE192191         | Member      | (removed)             | WP4 — Operator Dashboard & Admin            |
| Lê Bảo Khang             | SE190951         | Member      | (removed)        | WP5 — Billing, Loyalty & QA                 |

## 2. Product Background

Building an EV-charging network requires physical charging pillars (trụ sạc). Rather than developing hardware in-house — local hardware production capacity is still limited — many new, independent Vietnamese charging operators import ready-made, OCPP-compliant DC charging pillars from Chinese EVSE manufacturers. In this project, that hardware vendor is referred to as "ChargeLink"; the technical reference hardware is the D1 and YJ-EU DC charger product lines (Jiangxi Ruihua Intelligent Technology Co., Ltd.). The vendor only sells hardware: the pillars ship with a generic management app and cloud platform, usable but built for a global audience rather than the Vietnamese market. PowerMe's customer is therefore not the manufacturer but the Vietnamese operator who buys these pillars — and the drivers who charge at them.

That bundled software is not localized — no Vietnamese-language interface, no Vietnamese payment gateway, no VAT-compliant e-invoicing and no room for the operator's own pricing. A small operator has three poor options today: use the vendor's cloud as it is, build a CSMS, driver app, payment flow and e-invoicing itself (too expensive), or join a large network and lose its brand and pricing control. Four concrete gaps follow:

- **Vendor-bundled software does not fit the Vietnamese market:** language, currency, payment methods and e-invoicing in the default platform don't match a Vietnamese operator's business rules.

- **Independent operators cannot afford a full software stack:** a complete, localized CSMS + app + payment + e-invoicing stack is beyond a small operator's budget, and joining a closed network means giving up its own tariffs.

- **Drivers face a fragmented, uncertain experience:** one app per network (VETC's own press release names this: drivers "had to install multiple apps to access different charging providers"), stations their car cannot use shown by default, and no way to know when a busy charger will be free or which station will get them charging soonest.

- **Limited local operational visibility:** operators need a local-language dashboard, real-time fault alerts and support workflows suited to Vietnamese operations, which generic OEM software typically does not provide well.

This gap is what PowerMe is built to close: one shared, fully localized platform — its own OCPP 1.6J Charging Station Management System (CSMS), a driver app and an operator dashboard — that talks directly to ChargeLink's OCPP-compliant pillars. Independent operators join PowerMe instead of using the vendor's software, each managing its own pillars, sites and tariffs; drivers get every partner operator's pillars in one app.

## 3. Existing Systems

Seven apps/services active in Vietnam’s EV-charging landscape were reviewed directly (app-store listings, Play Store pages, and press coverage) to see how the market currently handles multi-network charging — and specifically how each one handles VinFast pillars, which are contractually closed to every other EV brand (VinFast’s own support documentation: non-VinFast drivers “will not be able to use the charging service at VinFast stations,” with no exception listed).

### 3.1 VinFast app (official OEM app)

Vehicle + charging control for VinFast owners only; no other network’s data at all. 3.2★ (41 ratings, US store). Even its own remote-start/climate/battery-status features are reported buggy. Closed ecosystem by design — not really a competitor to PowerMe so much as the reason PowerMe’s target segment (non-VinFast drivers) exists at all.

### 3.2 Trạm Sạc EV (EVCS JSC) and EV HUB / Trạm EV (Aydada)

Two well-built, well-reviewed (4.9★ each, hundreds of thousands of users combined) multi-network locator apps. Both list VinFast alongside other networks by default and let a user filter it out manually, per search. Neither app lets a driver start or pay for a session in-app — they solve “where,” not “how”: a driver still has to leave the app and use each individual network’s own app to actually charge.

### 3.3 EBOOST

Its own charging network (~1,000 points) with in-app QR-code payment and per-kWh billing — solves “how” within its own network, but not “where” beyond it. 3.2★ (113 reviews), with specific complaints about forced re-logins, slow screen loads, and pricing perceived as roughly double the electricity rate.

### 3.4 VETC

Vietnam’s toll-tag company, now aggregating find + connect + activate + pay across 4 partner networks (Tasco Smart Charge, Ford VN, ESKY, Rabbit EV), explicitly built for drivers “outside the VinFast ecosystem.” This is the one existing service validating PowerMe’s core thesis — unify transacting, exclude VinFast by design — but it covers only ~200–350 stations, is a bolt-on to a toll-tag product, and depends on four partners’ own backend integrations rather than operating its own CSMS. PowerMe pursues the same goal — one app across many networks — by a different mechanism: its own CSMS talking to the pillars directly, so live status and billing correctness are in its control.

### 3.5 ChargeLink Vietnam, Google Maps, PlugShare

ChargeLink Vietnam is a real, unrelated company (OCPP/OCPI infrastructure operator + franchise model) that happens to share a name with this project’s anonymized hardware-vendor placeholder — worth a one-line disambiguation if it comes up at defense. Google Maps and PlugShare are generic/crowdsourced map layers with no live operational status, no in-app payment, and no concept of vehicle compatibility at all.

## 4. Business Opportunity

Drivers mostly choose a station (location, price, compatibility) and then use whatever app that station requires — EBOOST drivers use EBOOST because they are at an EBOOST station. The stronger question is therefore why an independent operator would choose PowerMe, and what a driver gains when many operators do. For the operator, PowerMe is a complete localized stack — CSMS, app, VNPay top-ups, VAT e-invoicing — under its own tariffs, with billing that stays correct when a pillar's connection drops (this project's research question). For the driver, PowerMe puts many small operators' pillars in one app. None of the seven systems reviewed hides incompatible (VinFast-only) stations by default, and none ranks stations by the expected time until the driver is actually charging. PowerMe's structural advantage is that WP2 builds the OCPP CSMS directly rather than integrating other companies' black-box backends, so status accuracy, time-left estimates and reconciliation under network instability are in PowerMe's control, not a partner's. Against each competitor: the vendor cloud is not localized; EBOOST and the VinFast app are one company's closed network; VETC aggregates partners' back-ends instead of running its own CSMS; locator apps (Trạm Sạc EV, EV HUB) find stations but hand the driver to another app to charge and pay.

The market PowerMe is entering is explicitly the non-VinFast segment: EV drivers not on VinFast vehicles, and independent charging operators outside the VinFast/V-Green network running ChargeLink-style imported hardware (§3). VinFast's own app is the UX benchmark PowerMe measures itself against, not a segment it competes for. All evidence above is secondary (app-store listings and press, September 2026); primary evidence is being collected in Week 7, before the Review 2 dossier: a short driver survey (target ≥ 20 responses from an EV-owners' group) and a conversation with an independent operator; the results are added to this section and to Report 7. The claim that wait-ranked suggestions are not offered elsewhere covers only the seven apps reviewed and is re-checked before it is stated at Review 2.

## 5. Software Product Vision

For independent Vietnamese charging operators who run imported, OCPP-compliant pillars, and for the non-VinFast EV drivers who charge at them, PowerMe is the shared, Vietnamese-localized charging platform: operators get a complete CSMS, app, payment and e-invoicing stack without building one; drivers get every partner operator's pillars in one app, with live status and suggestions that get them charging soonest. Unlike locator-only apps (EVCS, EV HUB), which stop at "where," and single-network apps (EBOOST, the VinFast app), which stop at one closed network, PowerMe finds a compatible station, tells the driver when a busy connector will be free and which station gets them charging soonest, and completes the session end-to-end — in Vietnamese, paid from a prepaid Charging Credit, with VAT-compliant e-invoicing built in from the start.

## 6. Project Scope & Limitations

*Scope is stated with MoSCoW priorities, matching the SRS (Report 3) and the registration form v1.2: Must = committed scope, listed in §6.1 and on the registration form; Should and Could are listed in §6.2 so that the boundary is explicit and are not commitments. Codes in brackets trace each feature to the functional requirements FR-01–FR-17 and FR-21 of the registration form v1.2 (FR-18–FR-20 are Should) and the use cases in Report 3.*

### 6.1 Major Features (committed — Must)

**FE-01:** Driver App (Flutter) — top up a prepaid Charging Credit, then find, start/stop, and pay for a charging session on any partner operator's (ChargeLink-hardware) pillar, with a Vietnamese UI, real-time charging progress, charging, top-up and payment history with e-invoice access, in-app fault reporting, and an onboarding consent flow for personal-data processing (FR-01, FR-02, FR-04–FR-08).

**FE-02:** Vehicle-aware default filtering — a registered non-VinFast vehicle profile automatically excludes VinFast-only pillars from search results by default (with a visible override), since those pillars are categorically unusable to the rest of the market PowerMe targets (FR-03).

**FE-03:** OCPP 1.6J CSMS backend implementing the central-system role — BootNotification, Heartbeat, StatusNotification, Authorize, StartTransaction, MeterValues, StopTransaction, DataTransfer (logged), RemoteStartTransaction, RemoteStopTransaction, Reset, GetConfiguration, ChangeConfiguration (incl. requesting state-of-charge readings at boot) — over OCPP-J/TLS (Security Profile 2) (FR-16).

**FE-04:** Reconnection & reconciliation handling for WebSocket disconnects between a pillar and the CSMS: every message captured to an append-only log, StartTransaction idempotency (no double billing), detection of replayed messages after a reconnect, and an energy cross-check that flags gaps or conflicts on StopTransaction — measured in three controlled disconnect scenarios (energy error, duplicate/lost transactions, gap-detection precision/recall), compared with the same CSMS without reconciliation and with the SteVe reference CSMS (research question RQ1) (FR-16).

**FE-05:** Operator Dashboard (React) — each partner operator sees only its own pillars: pillar onboarding (issuing each pillar's OCPP credential), real-time status/fault monitoring and alerts with each pillar's uptime, utilisation and fault count, time-of-day tariff (Sharp / Peak / Shoulder / Off-peak) and promotion configuration, and review of sessions the CSMS could not attribute (FR-09–FR-13).

**FE-06:** Billing engine covering all 4 hardware-supported charging modes (auto-full, timed, by kWh, by cost), a prepaid Charging Credit ledger that every app or online-card session is paid from (start minimum, live credit cutoff, shortfall handling), and VAT-compliant e-invoice generation for each top-up through a licensed e-invoice provider (FR-04, FR-07).

**FE-07:** VNPay integration for Charging Credit top-ups, end-to-end (sandbox environment) (FR-07).

**FE-08:** Admin Console — platform-wide user/role management, pillar device registry, and RFID card registry (online vs. wallet cards, per-pillar free-vend tag) (FR-14, FR-15).

**FE-09:** Session classification — the CSMS records every session regardless of how it was started (app, RFID card, HMI password, free vend), classifies who collected payment, and never double-bills a session already paid at the pillar (FR-16).

**FE-10:** Pillar reliability signals — the CSMS keeps a history of every connector status change and computes each pillar's uptime, utilisation, fault count and failed-start rate for its operator; repeated fault reports from different drivers mark a connector with a "reported issue" label until the operator clears it. Both signals feed the station suggestion (FR-06, FR-10).

**FE-11:** Live connector status, time-left estimate and station suggestion — each connector is shown as Available, In use with an estimated time left (as a range), Freeing soon, Unavailable or Offline, with when it was last updated. The estimate uses the session's own limit when there is one, otherwise the state of charge with a DC charging-curve model, otherwise the pillar's history, and says "unknown" when none applies. The app suggests up to three stations ranked by expected time until charged (travel, wait and charging time) or by estimated cost at the tariff band in force on arrival, within the range of the battery level the driver enters, using travel times from a map & routing service; unreliable stations are labelled and ranked lower. The estimate and the suggestion are measured on the simulator against simple baselines (a straight-line estimate; the nearest compatible station, research question RQ2) (FR-03, FR-21).

**FE-12:** Loyalty points — earned on charging (1 point per 1,000 VND), viewed with history and upcoming expiry, redeemed against a Charging Credit top-up within limits; points expire after 12 months, have no cash value and are reversed if the session is refunded (FR-17).

### 6.2 Limitations & Exclusions

**LI-1:** No manufacturing, modification, or physical testing of real charging hardware — PowerMe is a software layer only, validated against an OCPP charge-point simulator, not real ChargeLink pillars. No hardware access and no vendor channel to the manufacturer are available; where the hardware manuals are silent at the protocol level (wallet-card balance reporting, free-vend identifiers, HMI-password identifiers), the pillar is modeled as a standard OCPP 1.6J charging station and the assumption is stated in the SRS.

**LI-2:** (Should — not committed) on-demand connector reservation (a short hold with no-show rules — designed in the SRS, held back because its enforcement and fee rules need more design), membership tiers, revenue/usage analytics, maintenance tickets, policy templates and the live in-app cost ticker are Should-level goals attempted once the Must scope is solid.

**LI-3:** (Could — not committed) a "notify me when a connector is free" alert, advance (scheduled) reservation and queueing for the next free connector, the full fault/alert taxonomy display, OCPP 2.0.1 support, MoMo/ZaloPay payment gateways, a generalized hardware-independent write-up of the reconciliation method, deeper analytics, and a UI/UX polish pass.

**LI-4:** The project does not build a custom payment gateway or e-invoicing provider from scratch — it integrates with VNPay and a licensed e-invoice provider (both in sandbox environments) rather than building new payment/tax infrastructure. It also does not manage RFID wallet cards themselves (issuance, top-up, balance) — it only records and classifies wallet-card sessions. Charging Credit is an advance payment for PowerMe's own charging service only — PowerMe does not operate an e-wallet: the credit cannot be withdrawn, transferred or spent on other goods or merchants (Decree 52/2024/ND-CP).

**LI-5:** True vehicle-initiated “Plug & Charge” (ISO 15118 certificate-based authentication) is out of scope — the reference D1/YJ-EU pillar firmware exposes OCPP 1.6J only. The hardware’s own “plug-and-charge” toggle is a vendor free-vend setting (no authentication), which PowerMe handles as an unattributed session; PowerMe’s fast-path session start is QR/app-based.

**LI-6:** PowerMe does not provide turn-by-turn navigation (the app hands off to Google Maps or the phone's map app), does not read the vehicle's battery level through telematics (the driver enters it), and does not build a routing engine — travel times come from a third-party map & routing service (Goong or Google Distance Matrix), called server-side.
