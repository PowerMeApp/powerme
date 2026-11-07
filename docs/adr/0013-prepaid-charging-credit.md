# ADR-0013 — Prepaid Charging Credit instead of pay-after-charging

| | |
|---|---|
| Status | Accepted |
| Date | 30/09/2026 (recorded in the repo 26/10/2026) |
| Decided by | Trần Đức Ân (WP1, PM/BA); owners WP5 (Khang), WP3 (Sơn), WP2 (Trí) |
| Related | FR-04, FR-05, FR-07, FR-08; BR-P04, BR-P13, BR-P18–BR-P23; ADR-0012; STM-4 TopUp, STM-5 CreditAccount |

## Context

The first design charged the driver after each session through VNPay. Nothing guaranteed payment: a driver could charge and leave without paying, and the unpaid-session rule had no good answer. It also produced one gateway call and one e-invoice per session. Vietnamese law limits stored-value products: under Decree 52/2024 an e-wallet (top up, withdraw, pay different merchants) may only be offered by banks and licensed intermediaries.

## Decision

Drivers top up a prepaid **Charging Credit** in the app through VNPay. Every `csms_billed` session is debited from that credit when it ends. `station_wallet` and `unattributed` sessions are unchanged (ADR-0012).

- **Start minimum** (BR-P18, proposed 50,000 VND): a session starts only if the available credit reaches it; a timed, kWh or cost limit is capped at what the credit can pay.
- **Cutoff reserve** (BR-P19, proposed 10,000 VND): the platform stops the session when the remaining credit reaches it, using the same running-cost logic as the cost limit.
- **Shortfall** (BR-P20): if a pillar could not be stopped (offline), the balance goes negative, new sessions are blocked and the next top-up covers it first.
- **Legal safeguards** (BR-P21, BR-P22): the credit pays only for charging sold through PowerMe; no withdrawal, transfer or interest; top-ups only through the licensed gateway; refunds only to the original source; per-top-up and balance caps (50,000–2,000,000 VND per top-up, 5,000,000 VND maximum balance). It is never called a "wallet" ("ví").
- **E-invoice at top-up** (BR-P04, Decree 123/2020 as amended by Decree 70/2025): money collected before the service is invoiced when collected. Each session gets a charging statement, not an invoice.
- Sandbox only: no real money is held in the capstone.

## Consequences

**Gains:**

- A mechanism, not a policy, answers "what stops a driver charging for free?".
- One gateway call per top-up instead of per session; no payment step after charging.
- The cutoff reuses the cost-limit logic that WP2 already needs.

**Costs:**

- A credit ledger (append-only, balance = sum of entries), idempotent top-up confirmation, a shortfall state and manual refunds (UC-ADM-08) must be built and tested (WP5).
- The multi-operator platform must act as seller of record (assumption A-PAY-01); a real launch needs a legal opinion.

## Options considered and rejected

| Option | Why rejected |
|---|---|
| Pay after each session through VNPay | No payment guarantee; one gateway call and one e-invoice per session |
| A full e-wallet (withdraw, pay other merchants) | Needs a payment-intermediary licence (Decree 52/2024) |
| Pre-authorisation hold on a card per session | Adds a gateway round-trip at every start and depends on card pre-authorisation support, which is outside the agreed payment scope |
