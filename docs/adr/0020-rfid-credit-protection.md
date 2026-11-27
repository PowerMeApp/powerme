# ADR 0020 — Session-keyed RFID credit protection

Accepted for local implementation, 27/11/2026. Depends on T148/T158; no deployment implied.

## Context

BR-P06 requires physical Start evidence to survive business denial. BR-P18/P19/P20 require
shared prepaid coverage and a conservative runtime cutoff. RFID settlement exists, but app
intent holds and automatic stops previously covered QR only. OCPP 1.6 RemoteStop Accepted
acknowledges the command, not StopTransaction or successful settlement.

## Decision

Add `rfid_credit_holds` keyed by session, referencing the captured owner's credit account.
Keep QR reservations in `driver_charge_intents`. `credit-availability.ts` defines monetary
availability as balance minus outstanding QR and RFID amounts; admission and refunds also
reject unresolved RFID obligations without a positive held budget. Paired statement/debit
evidence is required to dismiss legacy exposure. No historical balance is allocated by SQL.

Authorize is read-only. Start classifies under its SQL transaction and card share lock;
connector/session precede account, which serializes holds, refunds and late QR restoration.
A live current-epoch Start reserves all available credit if eligible. A denied but legitimate
billable physical Start retains its owner, zero obligation and durable stop decision. A replay
records zero obligation. Only validated fresh current-epoch meteredProgress may fund that
replay once, under session → account locks and before any Stop. The initial funded amount
never grows with top-ups, reconnect, duplicate Start or subsequent meters.

Use validated T134 meter/clock evidence and BigInt energy × highest daily tariff for BR-P19.
Protect both the initial funded budget and present account coverage excluding the session's
own hold. Missing tariff, conflicting/invalid meter or stale missing energy produces a safety
stop reason, never a zero estimate. A replay without live proof cannot dispatch a physical
stop. No-Stop orphaned/review sessions remain eligible for protection; financial review stays
review. Free vend/unattributed sessions have no hold, debit or credit cutoff.

`rfid_stop_jobs` is session-keyed and records reason, immutable attempt limit, cumulative
attempts, due time, current command and exhaustion metadata. Persist each attempt before RPC.
Total attempts = initial + configured `remoteStopRetryMax`; rejection, timeout, crash after
lease, and Accepted without Stop consume the same budget. Meters/reconnect/restart cannot
reset it. Accepted waits for Stop; only physical Stop completes the job. Late callbacks cannot
resurrect a completed job or overwrite command metadata once Stop evidence exists.

Recovery schedules at most four tasks without awaiting their RPCs; the bounded rotating scan
continues through other sessions. Session/account locks contain no RPC. Settlement, timers
and QR recovery continue while RFID calls are pending. Each RPC has a local timeout as well
as the transport timeout. Retry interval and reserve come from the existing policy.

T148 posts ledger, loyalty, segments, statement and hold release in one transaction. Review,
orphaned, pending tariff/meter and Accepted-without-Stop retain holds. T158 `account_closed`
remains terminal with no retry churn, release or debt forgiveness. Existing top-up refund
checks use shared coverage; D6 account closure is outside this change.

Existing Operator charge-point detail and Admin summary gain a separate bounded durable
`rfid_credit_protection` collection with counts and reasons. It does not depend on the latest
20 commands and does not alter revenue/unsettled reporting. Public RFID Stop remains 404 and
`can_stop=false`; Flutter cost-estimate capability stays unchanged.

## Alternatives and consequences

Unifying QR and RFID reservations would rewrite an established QR flow; additive session
holds preserve its contract. In-memory retry counters lose crash history. Reusing public
RFID Stop would widen driver authority. Automatically releasing on Accepted or review would
permit double spending. Keeping only recent commands hides exhausted jobs. Conservative
unfunded-debt admission may require operator reconciliation even with positive available
money; `/credit.blocking_rfid_sessions` makes this distinction explicit.

## Research provenance and licensing

Research examined the pinned source and tests below. The implementation adapts protocol and
testing ideas; no source code was copied and no dependencies were added.

| Pinned source | Fit, architecture, security, dependencies and tradeoff |
|---|---|
| [SteVe d5a5d1e6](https://github.com/steve-community/steve/tree/d5a5d1e6d1d717279c369e88cbe1bb3c533efc93), `RemoteStopTransactionTask`, `TransactionStopServiceHelperTest`, GPL-3.0 | Task/result separation and stop-evidence testing fit command semantics. Java task infrastructure does not fit the Nest/Postgres transaction boundary. No GPL code copied, linked, installed or run. Existing PowerMe command logging and restricted internal ingress keep the authority boundary. |
| [SAP simulator c3df7b7d](https://github.com/SAP/e-mobility-charging-stations-simulator/tree/c3df7b7dc875d18b086b46416c1fc6ce4124198f), `OCPP16IncomingRequestService`, RemoteStopUnlock tests, Apache-2.0 | Accepted/Rejected/error cases and transactionId-only payload inform contract tests. Simulator events cannot establish server settlement; no dependency or production simulator change. Adapting ideas into the existing worker has less maintenance cost than importing simulator command code. |
| [OCA 2025 UPI whitepaper §3.3](https://openchargealliance.org/wp-content/uploads/2025/11/OCA-Whitepaper-OCPP-UPI-mobile-payments.pdf) | Server metering/stop is delayed; OCPP 1.6 has no standard budget payload. Software reserve/cutoff reduces exposure but cannot guarantee a physical prepaid energy cap while disconnected. No vendor payload or hardware control extension. |

No new dependency, SDK, global config, hook, payment call or runtime database access.
