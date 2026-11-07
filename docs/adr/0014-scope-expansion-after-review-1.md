# ADR-0014 — Scope expansion after Review 1

| | |
|---|---|
| Status | Accepted; reservation part superseded by ADR-0015 |
| Date | 01/10/2026 (recorded in the repo 26/10/2026) |
| Decided by | Trần Đức Ân (WP1, PM/BA) |
| Related | FR-03, FR-17, FR-20, FR-21; BR-P24–BR-P37; UC-CHG-06, UC-CHG-07, UC-PAY-03, UC-PAY-04 |

## Context

At Review 1 (01/10/2026) the council judged the scope too small for a graduate project. The team works full-time and uses AI-assisted coding, so more Must scope was feasible, but it had to stay demonstrable before the final package.

## Decision

Move into Must, with business rules:

- **Station suggestion** (UC-CHG-07, FR-21): up to three stations ranked by expected wait on arrival, within the battery range the driver enters; incompatible, offline and faulted stations are never suggested (BR-P33).
- **Time left on busy connectors** shown as a range, never as a promise (BR-P32).
- **Loyalty** (UC-PAY-03, UC-PAY-04, FR-17): 1 point per 1,000 VND debited for `csms_billed` charging, earned when the session closes (BR-P34); redeemed only against a top-up at 100 points = 1,000 VND, minimum 500 points, at most 50% of the top-up (BR-P35); expiry after 12 months, no cash value, no transfer (BR-P36); reversal on amended or refunded sessions and restoration on refunded top-ups (BR-P37).
- **Reservation** (UC-CHG-06, FR-20, BR-P24–BR-P31) was also moved to Must; this part is superseded by ADR-0015 (back to Should).

## Consequences

**Gains:**

- Answers the Review 1 feedback with features no reviewed competitor combines (suggestion by expected wait, loyalty on prepaid credit).
- Loyalty reuses the Charging Credit ledger design (ADR-0013).

**Costs:**

- More Must effort (WBS 352 → 369 man-days at the time); WP4 and WP5 loads increased.
- Points must stay clear of e-money rules: no cash value, no transfer, top-up discount only.

## Options considered and rejected

| Option | Why rejected |
|---|---|
| Keep the Review 1 scope | Council feedback: too small |
| Add many new functions (fleet accounts, route planning) | Too wide to finish and test; the supervisor later advised depth over width (ADR-0015) |
