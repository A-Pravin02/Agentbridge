// ============================================
// AgentBridge - Security Configuration
// All thresholds in one place for easy tuning
// ============================================

export const SECURITY_CONFIG = {
  // ---- Escalation Thresholds ----

  /** Number of severe incidents in TIME_WINDOW_SEVERE_MS that triggers quarantine */
  QUARANTINE_SEVERE_INCIDENT_COUNT: 2,
  /** Time window for severe incident quarantine escalation (10 minutes) */
  TIME_WINDOW_SEVERE_MS: 10 * 60 * 1000,

  /** Total security violations in 24h before permanent block */
  PERMANENT_BLOCK_VIOLATION_COUNT: 5,
  /** Time window for permanent block escalation (24 hours) */
  TIME_WINDOW_BLOCK_MS: 24 * 60 * 60 * 1000,

  // ---- Threat Assessment Validity ----

  /** Threat assessment is valid for 5 minutes before re-analysis required */
  THREAT_ASSESSMENT_VALIDITY_MS: 5 * 60 * 1000,

  // ---- Request Integrity ----

  /** Maximum allowed clock skew for X-Timestamp header (±5 minutes) */
  TIMESTAMP_SKEW_MS: 5 * 60 * 1000,

  /** How long consumed request IDs are tracked before expiry (10 minutes) */
  REQUEST_ID_EXPIRY_MS: 10 * 60 * 1000,

  /** Idempotency key TTL (24 hours) */
  IDEMPOTENCY_KEY_TTL_MS: 24 * 60 * 60 * 1000,

  // ---- Severe Security Events ----
  // These trigger escalation when they occur, unlike ordinary policy failures.
  // See SecurityViolation enum in shared-types.
  SEVERE_VIOLATIONS: [
    'REPLAY_ATTACK',
    'IDEMPOTENCY_CONFLICT',
    'INVALID_REQUEST_SIGNATURE',
    'INVALID_STATE_TRANSITION',
    'EXTREME_REQUEST_FREQUENCY',
  ] as string[],

  // ---- Signing ----

  /** Whether request signing is enforced (can be false in demo mode) */
  ENFORCE_REQUEST_SIGNING: process.env.ENFORCE_SIGNING === 'true',
} as const;
