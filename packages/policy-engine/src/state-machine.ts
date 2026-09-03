// ============================================
// AgentBridge - Purchase State Machine
// ============================================
// Every state change in the system goes through `assertTransition`, inside the
// same database transaction that performs the write. The audit found that the
// previous implementation imported these helpers but guarded only one edge;
// the API now has no raw status writes at all.

import { PurchaseStatus, VALID_TRANSITIONS } from '@agentbridge/shared-types';

export class InvalidTransitionError extends Error {
  readonly from: PurchaseStatus;
  readonly to: PurchaseStatus;

  constructor(from: PurchaseStatus, to: PurchaseStatus) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: PurchaseStatus, to: PurchaseStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/** Throws unless the transition is permitted. Use at every write site. */
export function assertTransition(from: PurchaseStatus, to: PurchaseStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function transition(from: PurchaseStatus, to: PurchaseStatus): PurchaseStatus {
  assertTransition(from, to);
  return to;
}

export function getNextStates(from: PurchaseStatus): PurchaseStatus[] {
  return VALID_TRANSITIONS[from] ?? [];
}

export function isTerminalState(status: PurchaseStatus): boolean {
  return (VALID_TRANSITIONS[status] ?? []).length === 0;
}
