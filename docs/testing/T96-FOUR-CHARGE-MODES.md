# T96 — four charging modes: backend verification

Verified 19 November 2026 on local branch `wp3/t96-bon-che-do-sac`, based on
`origin/main` `c9589962047074d940bc26c5506c14f4a60166e1` (includes merged T134 and migration 0025).
Backend/API scope only; no Flutter, dependency changes or deployment. Local validation only;
CI, merge and staging verification are tracked in the PR.
The pre-sync WIP backup stash remains retained.

## Contract and implementation

The normative wire contract is [OpenAPI](../api/driver-api.openapi.yaml) and
[Driver API §17](../api/DRIVER-API-HOP-DONG.md#17-bốn-chế-độ-sạc--hợp-đồng-backend-wp3).

| Mode | Exclusive request limit | Persisted `sessions.limit_value` | Automatic condition |
|---|---|---|---|
| `full` | none | null | Charge-point BMS/manual StopTransaction; shared credit cutoff |
| `timed` | `duration_minutes` | original integer minutes | CSMS receipt wall time, including pauses; durable 10-second recovery sweep |
| `energy_kwh` | `energy_limit_wh` | original integer Wh | Exact observed milliWh comparison |
| `amount_vnd` | `amount_limit_vnd` | original integer VND | T134 cumulative pricing estimate, including approved boundary interpolation and start-tariff fallback |

Energy/money stop only after valid observed telemetry reaches the threshold. Sampling intervals,
command delivery and the charge point's actual stop can overshoot the selected energy/money
target; this is not a hard cap or predictive stop. Parent review reported staging session #515:
10 kWh requested, 10.23 kWh stopped, approximately 330 Wh sampled every 10 seconds. That report
is context supplied by the parent, not a staging check performed in this verification. Timed
has a nominal sweep delay up to 10 seconds plus processing/command latency; offline operation
or load can delay it further. Only actual StopTransaction proves that charging has stopped.

Credit protection uses exact observed energy at the maximum current tariff. Available credit
already at/below the reserve independently proves a cutoff, even without energy telemetry.
Public `consumed_wh` floors only for display; `estimated_cost_vnd` uses exact milliWh and ceil once.
The T134 estimate has its own `metered_cost_vnd_estimate`, quality (`exact`, `interpolated`,
`unknown`) and clock (`cp`, `cp_offset`, `csms`). Bounds remain separately named.

`resolveActiveTariffClock` reads real StartTransaction/MeterValues frames and shares the existing
T134 clock-resolution core. It never fabricates StopTransaction evidence. Final settlement retains
T134 offset correction, boundary interpolation, whole-session start-tariff fallback, shortfall,
review rules and exactly-once posting. Progress reads never write ledger or reconciliation records.

## Research, fit and applied edge cases

Source concepts were adapted in original project code. No source was copied, and no code from the
reference repositories was installed or executed. Existing locked project dependencies were executed
for tests and builds; no new runtime/development dependency was added. License/source pins are also
recorded in Driver API §17.

| Official source | Fit, tradeoff and adaptation | Actual tests/evidence |
|---|---|---|
| [evcc loadpoint.go](https://github.com/evcc-io/evcc/blob/1d62b732f81caa53ae827b38bed0e5380776a1a7/core/loadpoint.go), [session tests](https://github.com/evcc-io/evcc/blob/1d62b732f81caa53ae827b38bed0e5380776a1a7/core/loadpoint_session_test.go), MIT | Energy control loop and per-session baseline fit server-owned limits. Its Go/device stack is not imported; PostgreSQL durability and existing CSMS locks are retained. | `energy uses exact fractional readings while progress remains integer Wh; modest future clock still cuts off`; WF01 `normalizes kWh meter evidence for limit and reconciliation`; each journey uses its own actual StartTransaction baseline. |
| [SAP RemoteStop handler](https://github.com/SAP/e-mobility-charging-stations-simulator/blob/1d0f190e4ea659a68efb83c86ecbdf12b25cda4b/src/charging-station/ocpp/1.6/OCPP16IncomingRequestService.ts), [RemoteStopUnlock tests](https://github.com/SAP/e-mobility-charging-stations-simulator/blob/1d0f190e4ea659a68efb83c86ecbdf12b25cda4b/tests/charging-station/ocpp/1.6/OCPP16IncomingRequestService-RemoteStopUnlock.test.ts), Apache-2.0 | Simulator request handling supports ACK/effect distinction; reuse existing ocpp-rpc instead of importing a simulator stack. RemoteStop ACK cannot debit a session. | `amount uses cumulative tariff portions and keeps ACK separate from StopTransaction and settlement`; WF01 `T72 persists retry work and ACKs stop despite a real ledger write failure`; existing accepted/rejected retry/race tests. |
| [Node 24 timer overflow test](https://github.com/nodejs/node/blob/v24.0.0/test/parallel/test-timers-max-duration-warning.js), [official timers documentation](https://nodejs.org/api/timers.html) | Timer callback timing is approximate and delays above 2147483647 ms are clamped to 1 ms. Persist due times and compare bigint/numeric elapsed time; only a short sweep interval is scheduled. No timer-source copying. | `large persisted duration never becomes a Node timer overflow or an immediate stop`; `timed recovery after restart stops a paused session without any meter, with racing sweeps once` (also includes 51 older offline sessions before the reachable one). |
| [Stripe idempotent request documentation](https://docs.stripe.com/api/idempotent_requests) | Parameter comparison and retry after network failure fit durable intents. PowerMe deliberately returns an evolving snapshot, not a frozen Stripe-style response; no Stripe dependency or source copying. | Every `modeStart` sends two concurrent identical POSTs, checks one command, same intent/command IDs, replays the key, and checks changed-mode 409. `replays a legacy energy hash with the default mode, while rejecting a changed mode on its key`. |
| Existing merged T134 source/tests | Reuse approved clock offset and interpolation, rather than treating max tariff as actual money cost. Conservative measurement bounds remain visible, but the approved estimate drives money mode. | `T134 sparse money limit uses approved interpolation, while reporting measured bounds truthfully` (2 kWh: min 2000 / estimate 6000 / max 10000 VND); `T134 money fallback uses only the CSMS start tariff and never calls the maximum tariff actual cost`; `T134 recognizes live slow-clock frames beyond the replay flag and uses the same corrected clock at settlement`. |

Security retains owning-driver/vehicle validation, compatible connectors, P3-tag intent binding,
reserved automatic keys, current registry epoch fencing, freshness checks, session locks and
existing stop retry/idempotency rules. Every four-mode journey now performs actual OCPP Authorize
before StartTransaction and asserts Accepted without subtracting its own hold twice; reuse after
start is Invalid. A raw replay flag is not discarded: only a verified T134 live offset cluster can
explain it. Stale, foreign-epoch, conflicting and genuine replay evidence cannot prove a meter
limit. Offline grace retains the last observed display value without granting cutoff eligibility.

## Acceptance coverage

All tests below are in the existing discovered
[`driver-charges.integration.test.ts`](../../apps/csms/test/driver-charges.integration.test.ts),
with existing regressions in
[`wf01-driver-charging.integration.test.ts`](../../apps/csms/test/wf01-driver-charging.integration.test.ts).
The five explicit suite entries in `scripts/test-driver-discovery.mjs` already include the extended
charging suite; the local runner calls that same discovery script for `--all-driver`.

- Four real HTTP starts, correct durable mode/original limit, OCPP stop and exactly one statement/debit.
- Full BMS `Local` stop; SoC 100 does not trigger stop. Full shared credit cutoff with energy, and
  `full stops once when available credit reaches the reserve with only SoC and no energy sample`.
- Timed pause/restart/no-meter recovery, racing sweeps, offline candidate fairness and huge duration.
- Fractional energy precision (99.999 Wh displays 99, maximum cost 500 VND at 5000 VND/kWh), kWh
  normalization, batched/out-of-order samples and duplicate boundary samples.
- Every mode below minimum: no command and no session. Mode-specific cap offers require new-key
  acceptance; accepted cap remains the persisted original limit. Invalid unsafe/zero/negative/
  fractional/wrong-field bodies are covered by focused policy/HTTP units.
- Concurrent starts and same-key/different-mode comparison; P3 authorization before actual start.
- Missing/replayed/stale/old-epoch/conflicting telemetry is unknown, not zero; future CP clock,
  slow-clock live cluster, receipt fallback and offline last-known telemetry are covered.
- Existing WF01 tests retain ownership checks, manual/automatic stop races, accepted/rejected/
  unknown retry behavior, duplicate/late StopTransaction, billing-failure ACK isolation, shortfall,
  once-only debit/loyalty and T134 settlement policy.
- `migration 0026 preserves existing energy rows and enforces exclusive positive mode limits in
  real Postgres` applies the actual migration to a temporary legacy-shaped table. Normal suites
  also apply all migrations through upstream 0025 and the additive 0026. The legacy
  hash/default-mode replay is tested. API §17 documents the new intent columns, nullability,
  defaults and CHECK constraints; the physical database design document is outside this write scope.

## Reproduce locally

Use Node 24 (verified 24.22.3), installed workspace dependencies, and local socket/process access.
Do not load `infra/.env`. The runner sanitizes inherited database variables, allocates a random
loopback port and private embedded PostgreSQL cluster, and creates only dedicated test databases.
It stops its cluster in `finally`; data stays under ignored `apps/csms/.cache` for review.
Embedded PostgreSQL is 17.10.0-beta.17 from the existing helper; PostgreSQL 16 staging was not used.

From `apps/csms`, with Node 24 on PATH:

```powershell
node scripts/test-charge-modes-local.mjs --charges
node scripts/test-charge-modes-local.mjs --wf01
node scripts/test-charge-modes-local.mjs --all-driver
```

Typical wall times on this machine: charges 25–35 seconds including cluster initialization; WF01
5–6 minutes; all-driver 1–2 minutes. Test load and hardware affect these times. Selected WF01
regressions can be run without repeating the entire suite:

```powershell
node scripts/test-charge-modes-local.mjs --wf01 --testNamePattern 'DS01 full app service journey|progress separates socket loss|credit cutoff triggers|normalizes kWh|manual Stop is idempotent'
```

For the no-database suite, remove inherited test/application URLs first:

```powershell
$env:DATABASE_URL=$null
$env:MB03_TEST_DATABASE_URL=$null
node scripts/run-jest.cjs --runInBand
```

## Executed checks and results

Commands below ran from `apps/csms` using `$runtimeNode` selected by
`@(Get-Command node -All)[1].Source`, verified with `--version` as **v24.22.3**. All results below
are from this `c958996` verification, using existing dependencies. `.cache` logs are local
evidence and are not checked in. Checks ran sequentially; the broad no-database suite was not
repeated because this pass changed only import placement and documentation, not runtime logic.

| Executed command / log | Actual result |
|---|---|
| `& $runtimeNode scripts/test-charge-modes-local.mjs --all-driver` → `.cache/t96-c958996-all-driver.log` | **5 suites / 165 passed**, no skips: discovery 35 (9.103 s), smart 71 (11.522 s), auth 20 (7.844 s), charges 27 (22.073 s), vehicles 12 (5.583 s). Each suite uses its own empty real PostgreSQL database. |
| `& $runtimeNode scripts/test-charge-modes-local.mjs --wf01` → `.cache/t96-c958996-wf01.log` | **1 suite / 179 passed**, no skips, 284.578 s. Includes T134 offset, interpolation and start-tariff fallback, ownership, retry races, actual stop effects, billing-failure isolation and exactly-once settlement. |
| `& $runtimeNode scripts/run-jest.cjs --runInBand charge-mode-policy.spec charges.http.spec charge-start-policy.spec tariff-clock.spec` → `.cache/t96-c958996-focused.log` | **4 suites / 73 passed**, no skips, 6.448 s; sanitized database environment. |
| `& $runtimeNode ../../node_modules/typescript/bin/tsc --noEmit` → `.cache/t96-c958996-typecheck.log` | Passed. |
| `& $runtimeNode ../../node_modules/typescript/bin/tsc -p tsconfig.build.json` → `.cache/t96-c958996-build.log` | Passed. |
| `& $runtimeNode --check scripts/test-charge-modes-local.mjs` → `.cache/t96-c958996-syntax.log`; `& $runtimeNode ../../node_modules/prettier/bin/prettier.cjs --check <all 11 changed TS/MJS files>` → `.cache/t96-c958996-prettier.log` | Both passed. Markdown/YAML remain outside Prettier per repository configuration. |
| `& $runtimeNode .cache/check-driver-api.cjs` → `.cache/t96-c958996-openapi.log`; `git diff --check` → `.cache/t96-c958996-diffcheck.log` | OpenAPI YAML parsed, **339 internal references** resolved; four exclusive request shapes and additive progress/snapshot fields checked. Whitespace/conflict checks passed. No external OpenAPI schema-validation CLI was installed. |
| `& $runtimeNode .cache/t96-capture-ocpp.mjs t96-charge-modes-1795071020925` → `.cache/t96-c958996-ocpp-trace.jsonl` | Actual retained test database read in a read-only transaction; sanitized trace below. Both `0025_e-invoice-vat-rate` and `0026_driver_charge_modes` are recorded as applied. |

The first sandboxed local-DB attempt hit loopback `EACCES`; the passing integration runs above
used the required local socket permission. No staging URL was loaded. CSMS has no configured
lint script, so no lint-test pass is claimed. Expected ownership/billing-failure logs in WF01
are covered failure paths; its final result is 179 passed.

## Captured real OCPP sequence

Source: `ocpp_message_log` in the retained private test database
`powerme_mb03_driver_test_1795071057969_cf5c5d46`, mode `amount_vnd`, session/transaction **66**.
The capture selects only whitelisted protocol fields; no JWT, idTag, password or database URL.
Times below are actual CSMS receipt timestamps on 19 November 2026, UTC. `out` means CSMS → CP.
Response actions are correlated to their actual CALL by charge point, epoch and OCPP unique ID.

```text
06:51:07.648 out type=2 RemoteStartTransaction connector=1
06:51:07.649 in  type=3 RemoteStartTransaction status=Accepted
06:51:07.649 in  type=2 Authorize
06:51:07.656 out type=3 Authorize status=Accepted
06:51:07.657 in  type=2 StartTransaction connector=1 meterStart=1000 cp_time=06:51:06.000Z
06:51:07.663 out type=3 StartTransaction transaction=66 status=Accepted
06:51:07.701 in  type=2 MeterValues connector=1 transaction=66
06:51:07.719 out type=2 RemoteStopTransaction transaction=66
06:51:07.720 in  type=3 RemoteStopTransaction status=Accepted
06:51:07.747 in  type=2 StopTransaction transaction=66 meterStop=1200 reason=Remote
06:51:07.766 out type=3 StopTransaction status=Accepted
```

This excerpt omits a subsequent Authorize replay at 06:51:07.694/07.700 that correctly returned
Invalid, and the empty MeterValues response; the full sanitized JSONL retains them. The DB
confirms 200 Wh, **600 VND**, **one statement and one session debit**. The journey test also
asserts no statement after RemoteStop ACK while real StopTransaction is suppressed. Reproduce
with `node scripts/test-charge-modes-local.mjs --charges`; each run retains its own DB under
ignored `.cache` for inspection. The `.cache` capture helper and logs are local review evidence.

No staging database, infrastructure env file, mobile source or deployment was touched. No dependency
installation was needed. No Redocly/generated-client or PostgreSQL 16 run is claimed. Runtime,
intent migration, wire contract and their HTTP/OCPP regression tests form one coupled four-mode
API change; they are kept in one PR as requested despite the review-size guideline.
