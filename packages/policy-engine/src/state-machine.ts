// ============================================
// AgentBridge - Purchase State Machine
// Enforces valid transaction lifecycle transitions
// ============================================

import { PurchaseStatus, VALID_TRANSITIONS } from '@agentbridge/shared-types';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: PurchaseStatus,
    public readonly to: PurchaseStatus
  ) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Validates whether a state transition is allowed.
 * Returns true if the transition is valid, false otherwise.
 */
export function canTransition(from: PurchaseStatus, to: PurchaseStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Attempts a state transition. Throws InvalidTransitionError if invalid.
 * Returns the new state if valid.
 */
export function transition(from: PurchaseStatus, to: PurchaseStatus): PurchaseStatus {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
  return to;
}

/**
 * Returns all states reachable from the given state.
 */
export function getNextStates(from: PurchaseStatus): PurchaseStatus[] {
  return VALID_TRANSITIONS[from];
}

/**
 * Returns true if the state is a terminal state (no further transitions possible).
 */
export function isTerminalState(status: PurchaseStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}
