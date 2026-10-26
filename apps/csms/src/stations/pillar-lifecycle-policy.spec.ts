/**
 * STM-3 ChargingPillar lifecycle — one test per transition (TC-STM3-01..06, Brief A3) plus the
 * invalid moves CD-5 says the policy must refuse.
 */
import {
  InvalidPillarTransitionError,
  PillarLifecycle,
  PillarLifecycleEvent,
  PillarLifecyclePolicy,
  STM3_TRANSITIONS,
} from './pillar-lifecycle-policy';

describe('PillarLifecyclePolicy (STM-3 v0.3, ADR-0016)', () => {
  const policy = new PillarLifecyclePolicy();

  it('has exactly the 6 decided transitions', () => {
    expect(STM3_TRANSITIONS.map((t) => t.no)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each<[string, PillarLifecycle | null, PillarLifecycleEvent, PillarLifecycle]>([
    ['TC-STM3-01 [*] → registered (Admin registers serial)', null, 'REGISTER', 'registered'],
    [
      'TC-STM3-02 registered → awaiting_connection (onboard)',
      'registered',
      'ONBOARD',
      'awaiting_connection',
    ],
    [
      'TC-STM3-03 awaiting_connection → in_service (first connection)',
      'awaiting_connection',
      'FIRST_CONNECT',
      'in_service',
    ],
    ['TC-STM3-04 in_service → disabled', 'in_service', 'DISABLE', 'disabled'],
    ['TC-STM3-05 disabled → in_service', 'disabled', 'ENABLE', 'in_service'],
    ['TC-STM3-06 disabled → decommissioned', 'disabled', 'DECOMMISSION', 'decommissioned'],
  ])('%s', (_name, from, event, to) => {
    expect(policy.canApply(from, event)).toBe(true);
    expect(policy.transition(from, event)).toBe(to);
  });

  it.each<[PillarLifecycle | null, PillarLifecycleEvent]>([
    ['awaiting_connection', 'ONBOARD'], // onboarding twice
    ['in_service', 'ONBOARD'],
    ['registered', 'FIRST_CONNECT'], // connecting before onboarding
    ['in_service', 'DECOMMISSION'], // must be disabled first
    ['decommissioned', 'ENABLE'], // terminal
    ['registered', 'REGISTER'],
  ])('refuses %s + %s', (from, event) => {
    expect(policy.canApply(from, event)).toBe(false);
    expect(() => policy.transition(from, event)).toThrow(InvalidPillarTransitionError);
  });

  it('treats the legacy lifecycle value "offline" as in_service (legacy, no longer written since T61)', () => {
    expect(policy.transition('offline', 'DISABLE')).toBe('disabled');
    expect(policy.canApply('offline', 'ONBOARD')).toBe(false);
  });

  it('only onboarded, not retired pillars may open an OCPP connection', () => {
    expect(policy.mayConnect('registered')).toBe(false);
    expect(policy.mayConnect('decommissioned')).toBe(false);
    expect(policy.mayConnect('awaiting_connection')).toBe(true);
    expect(policy.mayConnect('in_service')).toBe(true);
    expect(policy.mayConnect('offline')).toBe(true);
    expect(policy.mayConnect('disabled')).toBe(true);
  });
});
