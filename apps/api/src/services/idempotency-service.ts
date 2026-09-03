// ============================================
// AgentBridge - Idempotency
// ============================================
//
// The Phase 0 audit found idempotency was opt-in by the caller: an attacker
// simply omitted the header. It is now MANDATORY on every mutating agent
// route — a request without an Idempotency-Key is refused, so retry-safety is
// not something a client can decline.
//
// Semantics:
//   same key + same body  -> the stored response is replayed, nothing re-runs
//   same key + diff body  -> 409 and a security incident (key reuse is an attack
//                            signal, not a client mistake)
//   new key               -> execute, then store the result
//
// Keys are scoped per agent, so one tenant cannot squat another's key space or
// probe whether a key exists.

import type { FastifyRequest } from 'fastify';
import { AuditAction, ActorType, SecurityViolation } from '@agentbridge/shared-types';
import { prisma, isUniqueViolation } from '../db.js';
import { getConfig } from '../config.js';
import { AppError, ConflictError } from '../lib/errors.js';
import { digestBody } from '../lib/crypto.js';
import { recordAuditEvent } from './audit-service.js';
import { recordSecurityIncident } from './security-service.js';

export interface IdempotencyScope {
  request: FastifyRequest;
  agentId: string;
  endpoint: string;
}

export class MissingIdempotencyKeyError extends AppError {
  constructor() {
    super(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header is required for this operation'
    );
  }
}

/**
 * Runs `operation` at most once per (agent, key).
 *
 * The result is persisted so a retry — however many times it arrives — returns
 * the original response rather than performing the work again.
 */
export async function withIdempotency<T>(
  scope: IdempotencyScope,
  operation: () => Promise<T>
): Promise<T> {
  const config = getConfig();
  const key = scope.request.headers['idempotency-key'];

  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new MissingIdempotencyKeyError();
  }

  const requestHash = digestBody(
    `${scope.endpoint}\n${scope.request.url}\n${(scope.request as { rawBody?: string }).rawBody ?? ''}`
  );

  const existing = await prisma.idempotencyRecord.findUnique({
    where: { agentId_idempotencyKey: { agentId: scope.agentId, idempotencyKey: key } },
  });

  if (existing) {
    if (existing.expiresAt.getTime() > Date.now()) {
      if (existing.requestHash === requestHash) {
        // Genuine retry — replay the original response byte for byte.
        return JSON.parse(existing.resultData) as T;
      }
      // Same key, different payload. Treat as an attack signal.
      await recordSecurityIncident({
        agentId: scope.agentId,
        type: SecurityViolation.IDEMPOTENCY_CONFLICT,
        description: 'An idempotency key was reused with a different payload',
        metadata: { endpoint: scope.endpoint },
      });
      await recordAuditEvent({
        action: AuditAction.IDEMPOTENCY_CONFLICT_DETECTED,
        actorType: ActorType.SYSTEM,
        actorId: 'idempotency',
        entityId: scope.agentId,
        metadata: { endpoint: scope.endpoint },
      });
      throw new ConflictError(
        'This idempotency key was already used with a different request body',
        SecurityViolation.IDEMPOTENCY_CONFLICT
      );
    }
    await prisma.idempotencyRecord.delete({ where: { id: existing.id } }).catch(() => undefined);
  }

  // Claim the key BEFORE doing the work. If two identical requests race, the
  // unique index means only one proceeds; the loser is told to retry.
  try {
    await prisma.idempotencyRecord.create({
      data: {
        agentId: scope.agentId,
        idempotencyKey: key,
        requestHash,
        endpoint: scope.endpoint,
        resultData: '{}',
        expiresAt: new Date(Date.now() + config.IDEMPOTENCY_TTL_MS),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        'A request with this idempotency key is already in progress',
        'IDEMPOTENCY_IN_PROGRESS'
      );
    }
    throw error;
  }

  try {
    const result = await operation();
    await prisma.idempotencyRecord.updateMany({
      where: { agentId: scope.agentId, idempotencyKey: key },
      data: { resultData: JSON.stringify(result) },
    });
    return result;
  } catch (error) {
    // A failed operation must not burn the key: the caller should be able to
    // fix the problem and retry with the same key.
    await prisma.idempotencyRecord
      .deleteMany({ where: { agentId: scope.agentId, idempotencyKey: key } })
      .catch(() => undefined);
    throw error;
  }
}

/** Housekeeping for expired idempotency and replay-nonce rows. */
export async function purgeExpired(now: Date = new Date()): Promise<{ keys: number; nonces: number }> {
  const [keys, nonces] = await Promise.all([
    prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.consumedRequest.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return { keys: keys.count, nonces: nonces.count };
}
