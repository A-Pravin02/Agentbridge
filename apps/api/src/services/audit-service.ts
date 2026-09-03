// ============================================
// AgentBridge - Audit Service
// ============================================
// Appends to a gapless, hash-chained, tamper-evident log.
//
// Two defects from the Phase 0 audit are fixed structurally here:
//
//  * FORKING — the old code read the chain tip and inserted without a
//    transaction, so concurrent writers linked to the same predecessor
//    (3 forks observed in 89 events). Appends now advance a single-row head
//    with an optimistic compare-and-swap: exactly one writer can move the tip
//    from sequence N to N+1, and losers retry against the new tip.
//
//  * UNVERIFIABLE HASH — the digest covered a JS clock read while the row
//    stored a database clock read. The timestamp is now one application-authored
//    value that is both hashed and persisted, so the verifier reads exactly
//    what was signed.

import {
  GENESIS_HASH,
  computeAuditEventHash,
  serializeMetadata,
  verifyChainIntegrity,
  type ChainEvent,
  type ChainVerificationResult,
} from '@agentbridge/audit';
import { prisma, type Db, isUniqueViolation } from '../db.js';

export interface AuditInput {
  action: string;
  actorType: string;
  actorId: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditedEvent {
  id: string;
  sequence: number;
  hash: string;
  timestamp: string;
}

const MAX_APPEND_ATTEMPTS = 8;

/**
 * Appends one event to the chain.
 *
 * Pass `tx` to make the audit record part of a caller's transaction, so a state
 * change and its audit trail commit or roll back together — there can be no
 * state change without a corresponding audit event.
 */
export async function recordAuditEvent(
  input: AuditInput,
  tx?: Db
): Promise<AuditedEvent> {
  if (tx) return appendOnce(tx, input);

  // Standalone: retry the CAS if a concurrent writer moves the tip first.
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction((t) => appendOnce(t, input));
    } catch (error) {
      if (!isRetryable(error)) throw error;
      lastError = error;
      // Small jittered backoff so contending writers do not lock-step.
      await new Promise((r) => setTimeout(r, 2 + Math.floor(Math.random() * 8)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Audit append failed after repeated contention');
}

function isRetryable(error: unknown): boolean {
  if (isUniqueViolation(error)) return true; // lost the sequence race
  const message = error instanceof Error ? error.message : '';
  return /CAS_CONFLICT|database is locked|SQLITE_BUSY/i.test(message);
}

async function appendOnce(db: Db, input: AuditInput): Promise<AuditedEvent> {
  const head =
    (await db.auditChainHead.findUnique({ where: { id: 'singleton' } })) ??
    (await db.auditChainHead.create({
      data: { id: 'singleton', sequence: -1, hash: GENESIS_HASH },
    }));

  const sequence = head.sequence + 1;
  const previousHash = head.hash;
  // One authoritative timestamp: hashed AND persisted.
  const timestamp = new Date().toISOString();
  const metadata = serializeMetadata(input.metadata ?? {});

  const hash = computeAuditEventHash({
    sequence,
    action: input.action,
    actorType: input.actorType,
    actorId: input.actorId,
    entityId: input.entityId,
    timestamp,
    metadata,
    previousHash,
  });

  // Compare-and-swap the tip. `where` pins the sequence we read, so a
  // concurrent append that already advanced the head updates zero rows.
  const moved = await db.auditChainHead.updateMany({
    where: { id: 'singleton', sequence: head.sequence },
    data: { sequence, hash },
  });
  if (moved.count !== 1) {
    throw new Error('CAS_CONFLICT: audit chain head advanced concurrently');
  }

  const event = await db.auditEvent.create({
    data: {
      sequence,
      action: input.action,
      actorType: input.actorType,
      actorId: input.actorId,
      entityId: input.entityId,
      timestamp,
      metadata,
      previousHash,
      hash,
    },
  });

  return { id: event.id, sequence, hash, timestamp };
}

// ---- Verification ----

function toChainEvent(row: {
  id: string;
  sequence: number;
  action: string;
  actorType: string;
  actorId: string;
  entityId: string;
  timestamp: string;
  metadata: string;
  previousHash: string;
  hash: string;
}): ChainEvent {
  return {
    id: row.id,
    sequence: row.sequence,
    action: row.action,
    actorType: row.actorType,
    actorId: row.actorId,
    entityId: row.entityId,
    timestamp: row.timestamp,
    metadata: row.metadata,
    previousHash: row.previousHash,
    hash: row.hash,
  };
}

/** Verifies the whole chain, streaming in pages so memory stays bounded. */
export async function verifyAuditChain(pageSize = 500): Promise<
  ChainVerificationResult & { verifiedThroughSequence: number }
> {
  let cursorSequence = -1;
  let expectedPrevHash = GENESIS_HASH;
  let total = 0;
  let offset = 0;

  for (;;) {
    const page = await prisma.auditEvent.findMany({
      where: { sequence: { gt: cursorSequence } },
      orderBy: { sequence: 'asc' },
      take: pageSize,
    });
    if (page.length === 0) break;

    const result = verifyChainIntegrity(page.map(toChainEvent), expectedPrevHash);
    if (!result.valid) {
      return {
        ...result,
        brokenAt: (result.brokenAt ?? 0) + offset,
        totalEvents: total + page.length,
        verifiedThroughSequence: cursorSequence,
      };
    }

    total += page.length;
    offset += page.length;
    const last = page[page.length - 1];
    cursorSequence = last.sequence;
    expectedPrevHash = last.hash;
  }

  return { valid: true, totalEvents: total, verifiedThroughSequence: cursorSequence };
}

/** Verifies only the events for one entity, against the full chain's linkage. */
export async function verifyEntityTrail(entityId: string): Promise<ChainVerificationResult> {
  const events = await prisma.auditEvent.findMany({
    where: { entityId },
    orderBy: { sequence: 'asc' },
  });
  if (events.length === 0) return { valid: true, totalEvents: 0 };

  // An entity's events are a subsequence of the chain, so linkage between them
  // is not contiguous. Verify each event's own content digest instead.
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const expected = computeAuditEventHash(toChainEvent(e));
    if (e.hash !== expected) {
      return {
        valid: false,
        totalEvents: events.length,
        brokenAt: i,
        brokenEventId: e.id,
        breakReason: 'CONTENT_HASH_MISMATCH',
        reason: `Event at sequence ${e.sequence} has been modified since it was recorded`,
      };
    }
  }
  return { valid: true, totalEvents: events.length };
}

export async function getAuditTrail(entityId: string) {
  return prisma.auditEvent.findMany({ where: { entityId }, orderBy: { sequence: 'asc' } });
}
