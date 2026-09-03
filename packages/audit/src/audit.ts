// ============================================
// AgentBridge - Cryptographic Audit Core
// Tamper-evident hash chaining & verification
// ============================================
//
// H(n) = SHA256( canonical(event n) || H(n-1) )
//
// Two defects in the previous implementation are corrected here, both found by
// the Phase 0 audit:
//
// 1. TIMESTAMP DIVERGENCE — the hash was computed over a JS `new Date()` read,
//    while the row's `createdAt` was written independently by the database.
//    The two clock reads differed (measured: 2 ms), so the recomputed hash
//    could never match and verification failed 100% of the time. The event
//    timestamp is now an explicit, application-authoritative field that is
//    both hashed and persisted, so the verifier reads exactly what was signed.
//
// 2. INCOMPLETE COVERAGE — the hash covered only action, timestamp, metadata
//    and previousHash. `actorType`, `actorId` and `entityId` were NOT hashed,
//    so an attacker could rewrite *who did what to whom* and the chain would
//    still verify. All identity fields are now inside the digest.
//
// A `sequence` field gives the chain a total order that does not depend on a
// non-unique timestamp, and lets the verifier detect deletions (a gap) as well
// as modifications.

import { createHash } from 'crypto';

export const GENESIS_HASH = 'GENESIS';

export interface AuditEventCore {
  sequence: number;
  action: string;
  actorType: string;
  actorId: string;
  entityId: string;
  /** ISO-8601 string, authored by the application and persisted verbatim. */
  timestamp: string;
  /** Canonical JSON string. Use `serializeMetadata` to produce it. */
  metadata: string;
  previousHash: string;
}

export interface ChainEvent extends AuditEventCore {
  id?: string;
  hash: string;
}

export type ChainBreakReason =
  | 'PREVIOUS_HASH_MISMATCH'
  | 'CONTENT_HASH_MISMATCH'
  | 'SEQUENCE_GAP'
  | 'GENESIS_MISMATCH';

export interface ChainVerificationResult {
  valid: boolean;
  totalEvents: number;
  /** Index into the supplied array where verification failed. */
  brokenAt?: number;
  /** Database id of the offending event, when known. */
  brokenEventId?: string;
  breakReason?: ChainBreakReason;
  reason?: string;
}

/**
 * Deterministically serializes metadata: keys sorted recursively at every
 * depth, so the same logical object always produces the same string on any
 * runtime or platform.
 *
 * The previous implementation passed a key array to JSON.stringify, which is a
 * replacer allow-list applied at every nesting level — it did not sort, and it
 * silently stripped nested keys. This does it properly.
 */
export function serializeMetadata(metadata: Record<string, unknown> | string | null | undefined): string {
  if (metadata === null || metadata === undefined) return '{}';

  let value: unknown = metadata;
  if (typeof metadata === 'string') {
    try {
      value = JSON.parse(metadata);
    } catch {
      // Not JSON — hash the raw string as-is rather than losing information.
      return metadata;
    }
  }
  if (typeof value !== 'object' || value === null) return '{}';
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortDeep(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * Builds the canonical pre-image for an event. Field separator is a character
 * that cannot appear unescaped in the JSON metadata or in an identifier, so
 * field boundaries are unambiguous and no two distinct events can collide by
 * shifting content across a separator.
 */
export function canonicalizeEvent(core: AuditEventCore): string {
  return [
    String(core.sequence),
    core.action,
    core.actorType,
    core.actorId,
    core.entityId,
    core.timestamp,
    serializeMetadata(core.metadata),
    core.previousHash,
  ].join('');
}

export function computeAuditEventHash(core: AuditEventCore): string {
  return createHash('sha256').update(canonicalizeEvent(core), 'utf8').digest('hex');
}

/**
 * Verifies a chain segment.
 *
 * `events` must be ordered by ascending `sequence`. When the segment starts at
 * sequence 0 the first event must reference GENESIS; when verifying a later
 * window, pass the known-good hash of the preceding event as `expectedFirstPrevHash`.
 */
export function verifyChainIntegrity(
  events: ChainEvent[],
  expectedFirstPrevHash: string = GENESIS_HASH
): ChainVerificationResult {
  if (events.length === 0) return { valid: true, totalEvents: 0 };

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // 1. Linkage.
    const expectedPrev = i === 0 ? expectedFirstPrevHash : events[i - 1].hash;
    if (event.previousHash !== expectedPrev) {
      return {
        valid: false,
        totalEvents: events.length,
        brokenAt: i,
        brokenEventId: event.id,
        breakReason: i === 0 ? 'GENESIS_MISMATCH' : 'PREVIOUS_HASH_MISMATCH',
        reason:
          `Chain linkage broken at index ${i} (sequence ${event.sequence}): ` +
          `expected previousHash '${expectedPrev}', found '${event.previousHash}'`,
      };
    }

    // 2. No deletions — sequence must advance by exactly one.
    if (i > 0 && event.sequence !== events[i - 1].sequence + 1) {
      return {
        valid: false,
        totalEvents: events.length,
        brokenAt: i,
        brokenEventId: event.id,
        breakReason: 'SEQUENCE_GAP',
        reason:
          `Sequence gap before index ${i}: jumped from ${events[i - 1].sequence} ` +
          `to ${event.sequence}. One or more events were deleted.`,
      };
    }

    // 3. Content integrity.
    const expectedHash = computeAuditEventHash(event);
    if (event.hash !== expectedHash) {
      return {
        valid: false,
        totalEvents: events.length,
        brokenAt: i,
        brokenEventId: event.id,
        breakReason: 'CONTENT_HASH_MISMATCH',
        reason:
          `Content hash mismatch at index ${i} (sequence ${event.sequence}): ` +
          `this event's payload has been modified since it was recorded.`,
      };
    }
  }

  return { valid: true, totalEvents: events.length };
}
