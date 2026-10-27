# ADR-0016 — Offline grace period, review on conflict, pillar connectivity split from lifecycle

| | |
|---|---|
| Status | Accepted (implemented in PR #44, T61); grace value decided 26/10/2026 |
| Date | 24/10/2026 (recorded in the repo 26/10/2026) |
| Decided by | Trần Đức Ân (WP1, PM/BA) after comparing the WP2 code with the WP1 design |
| Related | STM-1 ChargingSession, STM-3 ChargingPillar; BR-P19, BR-P39; F-10; ADR-0005, ADR-0010; T61; G18, G19 |

## Context

In Iteration 1 the CSMS moved a running session to `orphaned` as soon as the pillar's WebSocket closed. OCPP sockets drop for a few seconds often (Wi-Fi or 4G at the site). Every blip therefore orphaned the session, filled the operator's review list, and — because the session stayed `orphaned` after reconnect — stopped the credit cutoff (BR-P19), which only watches `active` sessions. Pillar connectivity was also stored inside the administrative lifecycle (`in_service ⇄ offline`), so a `disabled` pillar that reconnected was set back to `in_service`.

## Decision

- **D-A Offline grace period.** A socket close marks the pillar offline but does not change the session. Only if the pillar has not reconnected (no newer connection epoch) after `OFFLINE_GRACE_S` does the session move to `orphaned`. A reconnect inside the grace cancels it. `orphaned → active` is added for when live readings return with no stop.
- **D-B** Keep the `review` state (billing held until an operator resolves) and add `closed → review` for a reconciliation conflict on a session that closed online.
- **D-C** Split connectivity (`charge_points.is_online`, `online_changed_at`) from the lifecycle (`registered → awaiting_connection → in_service ⇄ disabled → decommissioned`). Connecting only moves `awaiting_connection → in_service`; a disconnect never changes the lifecycle.
- **D-D / D-E** Keep WP2's behaviour: a reconnect needs no BootNotification; `orphaned → reconciled` directly.
- **D-F** Credit ledger, top-ups and loyalty live in `billing` (WP5); `FaultService` stays in `stations` (WP4); a `suggestions` module (WP3); push notifications (FCM) are out of Review 2 scope.

**Grace value (G18).** Default **120 s** (decided by WP1 on 26/10/2026), configurable with `OFFLINE_GRACE_S`; the demo may use a shorter value. Reasons:

- A network blip is expected to reconnect within seconds to about a minute, as pillars retry the WebSocket with back-off; 120 s leaves room for a couple of retries. This is an assumption to check on the simulator and, if possible, on a real pillar.
- 2 × heartbeat (600 s with the 300 s heartbeat) would show a session that has really lost its pillar as `active` for ten minutes.
- It stays well inside the offline alert bound (F-10, ≤ 900 s); the alert itself is WF-04's (G19).

## Consequences

**Gains:**

- Short drops are invisible to drivers and operators; real outages still orphan and reconcile.
- The credit cutoff keeps working after a reconnect.
- A disabled pillar stays disabled when it reconnects.

**Costs:**

- One more configuration value and one more transition in STM-1 (and its tests).
- The implementation uses an in-process timer with a startup sweep instead of a BullMQ delayed job (no Redis yet); a restart is covered by the sweep.

## Options considered and rejected

| Option | Why rejected |
|---|---|
| Orphan immediately on socket close (Iteration 1) | Every blip orphans the session and the credit cutoff stops working after reconnect |
| Immediate orphan plus `orphaned → active` only | Fixes the cutoff, but blips still flood the review list and the app |
| Grace = 2 × heartbeat (600 s) | Hides real outages from the driver for too long |
| Grace = 30 s (placeholder in PR #44) | Close to a pillar's first reconnect back-off, so normal blips could still orphan sessions |
