# ADR-0015 — Reservation back to Should; live status, time left and suggestion deepened

| | |
|---|---|
| Status | Accepted (supersedes the reservation part of ADR-0014) |
| Date | 09/10/2026 (recorded in the repo 26/10/2026) |
| Decided by | Team meeting 09/10/2026; recorded by Trần Đức Ân (WP1) |
| Related | FR-03, FR-06, FR-10, FR-20, FR-21; BR-P38–BR-P43; NFR-RES-02–NFR-RES-04; UC-CHG-01, UC-CHG-05, UC-CHG-06, UC-CHG-07, UC-OPS-02 |

## Context

Reservation needs hold enforcement, fees, concurrency and fairness rules. The pillar manuals do not document the OCPP Reservation profile, so a platform-side hold would be needed. The supervisor advised growing scope by going deeper into existing functions rather than adding new ones. Live connector status only needs `StatusNotification` and `Heartbeat`, which are mandatory in OCPP 1.6J Core.

## Decision

- **Reservation** (UC-CHG-06, FR-20, BR-P24–BR-P31) moves from Must to **Should**; its design stays in the SRS.
- **Live status deepened** (FR-03): driver-facing mapping Available / In use / Freeing soon / Unavailable / Offline (BR-P38); freshness, with "may be out of date" after two heartbeat intervals (BR-P39); append-only status history (`connector_status_events`).
- **Time left v2** (BR-P40): first level with data wins — session limit, SoC with a DC charging curve, pillar history, otherwise "unknown"; measured against the linear baseline (NFR-RES-03).
- **Suggestion v2** (FR-21, BR-P41): Fastest = travel + wait + charging time; Cheapest = estimated cost at the tariff band on arrival; reliability penalty from uptime and driver reports (BR-P42); evaluated against nearest-station in a simulator experiment (NFR-RES-04, RQ2).
- **Uptime and utilisation** per pillar for operators (FR-10, BR-P43).
- Loyalty stays Must (ADR-0014).

## Consequences

**Gains:**

- Must load fits capacity (Must 298 of 325 man-days at the time); reservation becomes the explicit buffer.
- A second, smaller measured research question (RQ2) next to reconciliation (RQ1).

**Costs:**

- Reviewers may read "reservation moved to Should" as a scope cut; the answer is the measured depth above.
- More backend work for WP4 (status history, estimator, suggestion, uptime).

## Options considered and rejected

| Option | Why rejected |
|---|---|
| Keep reservation in Must | Design not ready; pillar support for `ReserveNow` not documented |
| Drop status and suggestion as well | Removes the features that differentiate the platform |
| "Notify me when free" instead of reservation, in Must | Needs push notifications (FCM), which are out of Review 2 scope; kept as Could |
