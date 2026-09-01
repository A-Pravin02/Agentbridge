// ============================================
// AgentBridge - Request Integrity Service
// Layer 1: Confirmed Security Violation Checks
// ============================================

import { createHash, timingSafeEqual, createHmac } from 'crypto';
import { prisma } from './db.js';
import { SECURITY_CONFIG } from './security-config.js';
import { SecurityViolation } from '@agentbridge/shared-types';

export interface IntegrityCheckResult {
  passed: boolean;
  violation?: SecurityViolation;
  message: string;
  isSevere: boolean;
}

// ---- Agent Status Check ----

/**
 * Checks the agent's security status.
 * Returns immediately for QUARANTINED/BLOCKED/SUSPENDED agents.
 * This is the first gate — no further processing for non-ACTIVE agents.
 */
export async function checkAgentStatus(agentId: string): Promise<IntegrityCheckResult> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, status: true, name: true },
  });

  if (!agent) {
    return {
      passed: false,
      violation: SecurityViolation.UNKNOWN_AGENT,
      // Do not reveal whether the agent exists or not in external-facing messages
      message: 'Agent identity could not be verified',
      isSevere: false,
    };
  }

  if (agent.status !== 'ACTIVE') {
    return {
      passed: false,
      violation: SecurityViolation.INACTIVE_AGENT,
      // Generic message — do not reveal internal quarantine/block details to the caller
      message: 'Agent access has been suspended pending security review',
      isSevere: false,
    };
  }

  return { passed: true, message: 'Agent status: ACTIVE', isSevere: false };
}

// ---- Timestamp Validation ----

/**
 * Validates X-Timestamp header is within ±TIMESTAMP_SKEW_MS of current time.
 * Expired or future-dated requests are blocked.
 *
 * IMPORTANT: Expire requests are classified as EXPIRED_REQUEST violations,
 * which are treated as security incidents but not SEVERE (not in SEVERE_VIOLATIONS list).
 */
export function validateTimestamp(timestampHeader: string | undefined): IntegrityCheckResult {
  if (!timestampHeader) {
    return {
      passed: false,
      violation: SecurityViolation.EXPIRED_REQUEST,
      message: 'Missing X-Timestamp header',
      isSevere: false,
    };
  }

  const ts = parseInt(timestampHeader, 10);
  if (isNaN(ts)) {
    return {
      passed: false,
      violation: SecurityViolation.EXPIRED_REQUEST,
      message: 'Invalid X-Timestamp format',
      isSevere: false,
    };
  }

  const now = Date.now();
  const diff = Math.abs(now - ts);

  if (diff > SECURITY_CONFIG.TIMESTAMP_SKEW_MS) {
    return {
      passed: false,
      violation: SecurityViolation.EXPIRED_REQUEST,
      message: 'Request timestamp is outside the allowed window',
      isSevere: false,
    };
  }

  return { passed: true, message: 'Timestamp valid', isSevere: false };
}

// ---- Replay Protection (X-Request-ID) ----

/**
 * Checks whether X-Request-ID has already been consumed by this agent.
 * A unique request ID per agent prevents replay attacks.
 *
 * This is SEPARATE from idempotency:
 * - Replay: same requestId reused → BLOCK (security incident)
 * - Idempotency: same Idempotency-Key + same body → safe retry (return original result)
 */
export async function checkReplayProtection(
  agentId: string,
  requestId: string,
  requestHash: string
): Promise<IntegrityCheckResult> {
  // Clean up expired records
  await prisma.consumedRequest.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  const existing = await prisma.consumedRequest.findUnique({
    where: { agentId_requestId: { agentId, requestId } },
  });

  if (existing) {
    return {
      passed: false,
      violation: SecurityViolation.REPLAY_ATTACK,
      message: 'This request has already been processed',
      isSevere: true, // REPLAY is a severe violation
    };
  }

  return { passed: true, message: 'Request ID is fresh', isSevere: false };
}

/**
 * Marks a request ID as consumed for replay protection.
 * Call this AFTER successfully processing the request.
 */
export async function consumeRequestId(
  agentId: string,
  requestId: string,
  requestHash: string
): Promise<void> {
  const expiresAt = new Date(Date.now() + SECURITY_CONFIG.REQUEST_ID_EXPIRY_MS);
  await prisma.consumedRequest.create({
    data: { agentId, requestId, requestHash, expiresAt },
  });
}

// ---- Idempotency Check ----

/**
 * Checks idempotency for payment execution.
 *
 * - Same key + same hash → safe retry, return existing result
 * - Same key + different hash → IDEMPOTENCY_CONFLICT → BLOCK
 * - New key → proceed normally
 */
export async function checkIdempotency(
  idempotencyKey: string,
  requestHash: string,
  endpoint: string
): Promise<{ result: 'NEW' | 'EXISTING' | 'CONFLICT'; existingData?: unknown }> {
  // Clean up expired records
  await prisma.idempotencyRecord.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  const existing = await prisma.idempotencyRecord.findUnique({
    where: { idempotencyKey },
  });

  if (!existing) return { result: 'NEW' };

  if (existing.requestHash === requestHash) {
    // Safe retry — return original result
    return {
      result: 'EXISTING',
      existingData: JSON.parse(existing.resultData),
    };
  }

  // Different payload — conflict
  return { result: 'CONFLICT' };
}

/**
 * Stores idempotency result after successful processing.
 */
export async function storeIdempotencyResult(
  idempotencyKey: string,
  requestHash: string,
  endpoint: string,
  resultData: unknown
): Promise<void> {
  const expiresAt = new Date(Date.now() + SECURITY_CONFIG.IDEMPOTENCY_KEY_TTL_MS);
  await prisma.idempotencyRecord.upsert({
    where: { idempotencyKey },
    create: {
      idempotencyKey,
      requestHash,
      endpoint,
      resultData: JSON.stringify(resultData),
      status: 'COMPLETED',
      expiresAt,
    },
    update: {
      status: 'COMPLETED',
      resultData: JSON.stringify(resultData),
    },
  });
}

// ---- Agent-Specific HMAC Signature Verification ----

/**
 * Constructs the canonical request string for HMAC signing.
 *
 * Format: agentId|requestId|timestamp|METHOD|path|SHA256(body)
 *
 * The body hash ensures that modifying amount or any field invalidates the signature.
 * This canonical form is deterministic — server and client must produce the same string.
 */
export function buildCanonicalRequest(
  agentId: string,
  requestId: string,
  timestamp: string,
  method: string,
  path: string,
  rawBody: string
): string {
  const bodyHash = createHash('sha256').update(rawBody || '').digest('hex');
  return `${agentId}|${requestId}|${timestamp}|${method.toUpperCase()}|${path}|${bodyHash}`;
}

/**
 * Verifies agent-specific HMAC signature.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 * Each agent has its own signing secret — compromising one does not affect others.
 *
 * Returns INVALID_REQUEST_SIGNATURE if:
 * - Agent has no signing secret configured
 * - Signature header is missing
 * - Signature does not match
 */
export async function verifyAgentSignature(
  agentId: string,
  canonicalRequest: string,
  signatureHeader: string | undefined
): Promise<IntegrityCheckResult> {
  if (!SECURITY_CONFIG.ENFORCE_REQUEST_SIGNING) {
    // Signing not enforced in demo mode
    return { passed: true, message: 'Signing not enforced (demo mode)', isSevere: false };
  }

  if (!signatureHeader) {
    return {
      passed: false,
      violation: SecurityViolation.INVALID_REQUEST_SIGNATURE,
      message: 'Missing X-Agent-Signature header',
      isSevere: true,
    };
  }

  // Fetch signing secret — select only the field we need, never return full agent
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { signingSecret: true },
  });

  if (!agent?.signingSecret) {
    // Agent not configured with signing — treat as unverifiable
    return {
      passed: false,
      violation: SecurityViolation.INVALID_REQUEST_SIGNATURE,
      message: 'Agent request signing is not configured',
      isSevere: true,
    };
  }

  // Compute expected HMAC
  const expected = createHmac('sha256', agent.signingSecret)
    .update(canonicalRequest)
    .digest('hex');

  // Timing-safe comparison
  try {
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(signatureHeader, 'hex');

    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return {
        passed: false,
        violation: SecurityViolation.INVALID_REQUEST_SIGNATURE,
        message: 'Request signature verification failed',
        isSevere: true,
      };
    }
  } catch {
    return {
      passed: false,
      violation: SecurityViolation.INVALID_REQUEST_SIGNATURE,
      message: 'Request signature verification failed',
      isSevere: true,
    };
  }

  return { passed: true, message: 'Signature verified', isSevere: false };
}

/**
 * Hashes a request body deterministically.
 * Used by both client and server to ensure the same body produces the same hash.
 */
export function hashRequestBody(body: unknown): string {
  const canonical = JSON.stringify(body, Object.keys(body as object).sort());
  return createHash('sha256').update(canonical).digest('hex');
}
