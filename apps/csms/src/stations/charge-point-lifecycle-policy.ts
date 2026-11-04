/**
 * ChargePointLifecyclePolicy — the single place that decides STM-3 (ChargePoint lifecycle)
 * transitions for the WF-05 onboarding slice.
 *
 * Why it exists: CD-5 (Report 4 §3.6) puts every STM-3 transition behind one pure class so the
 * transition tests can hit it without a database. States follow STM-3 v0.3 (ADR-0016 D-C):
 * lifecycle is administrative only; online/offline is connectivity, not a lifecycle state.
 *
 *   #1 [*]                 → registered           REGISTER       Admin adds serial (UC-ADM-03)
 *   #2 registered          → awaiting_connection  ONBOARD        Operator onboards (UC-OPS-01)
 *   #3 awaiting_connection → in_service           FIRST_CONNECT  first accepted connection (UC-INT-01)
 *   #4 in_service          → disabled             DISABLE        Operator takes it out of service
 *   #5 disabled            → in_service           ENABLE         Operator returns it to service
 *   #6 disabled            → decommissioned       DECOMMISSION   Admin retires the device
 *
 * T61 (ADR-0016 D-C) moved connectivity to `charge_points.is_online`; the gateway no longer writes
 * `offline` and migration 0002 rewrote old rows to `in_service`. The enum value itself cannot be
 * dropped from Postgres safely, so it stays as LEGACY and a charge point whose lifecycle still reads
 * `offline` is treated as `in_service` here: it has been in service before.
 */
export type ChargePointLifecycle =
  'registered' | 'awaiting_connection' | 'in_service' | 'offline' | 'disabled' | 'decommissioned';

export type ChargePointLifecycleEvent =
  'REGISTER' | 'ONBOARD' | 'FIRST_CONNECT' | 'DISABLE' | 'ENABLE' | 'DECOMMISSION';

export class InvalidChargePointTransitionError extends Error {
  constructor(
    readonly from: ChargePointLifecycle | null,
    readonly event: ChargePointLifecycleEvent,
  ) {
    super(`STM-3: event ${event} is not allowed from ${from ?? '[*]'}`);
    this.name = 'InvalidChargePointTransitionError';
  }
}

interface Transition {
  no: number;
  from: ChargePointLifecycle | null;
  event: ChargePointLifecycleEvent;
  to: ChargePointLifecycle;
}

/** STM-3 v0.3 transition table (numbers match the diagram and Report 5 TC-STM3-xx). */
export const STM3_TRANSITIONS: readonly Transition[] = [
  { no: 1, from: null, event: 'REGISTER', to: 'registered' },
  { no: 2, from: 'registered', event: 'ONBOARD', to: 'awaiting_connection' },
  { no: 3, from: 'awaiting_connection', event: 'FIRST_CONNECT', to: 'in_service' },
  { no: 4, from: 'in_service', event: 'DISABLE', to: 'disabled' },
  { no: 5, from: 'disabled', event: 'ENABLE', to: 'in_service' },
  { no: 6, from: 'disabled', event: 'DECOMMISSION', to: 'decommissioned' },
];

/** Legacy value written by ConnectionRegistry on socket close (pre-T61, no longer written); see header. */
function normalise(state: ChargePointLifecycle | null): ChargePointLifecycle | null {
  return state === 'offline' ? 'in_service' : state;
}

export class ChargePointLifecyclePolicy {
  /** Next lifecycle for `event`, or throws InvalidChargePointTransitionError. */
  transition(
    from: ChargePointLifecycle | null,
    event: ChargePointLifecycleEvent,
  ): ChargePointLifecycle {
    const current = normalise(from);
    const t = STM3_TRANSITIONS.find((x) => x.from === current && x.event === event);
    if (!t) throw new InvalidChargePointTransitionError(from, event);
    return t.to;
  }

  canApply(from: ChargePointLifecycle | null, event: ChargePointLifecycleEvent): boolean {
    const current = normalise(from);
    return STM3_TRANSITIONS.some((x) => x.from === current && x.event === event);
  }

  /**
   * May a charge point in this lifecycle open an OCPP connection (SD-5b step 3)?
   * Not onboarded yet (`registered`) or retired (`decommissioned`) → no. A `disabled` charge point may
   * stay online (STM-3 note) — it is only hidden from drivers.
   */
  mayConnect(state: ChargePointLifecycle): boolean {
    return state !== 'registered' && state !== 'decommissioned';
  }
}
