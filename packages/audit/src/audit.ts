// ============================================
// AgentBridge - Cryptographic Audit Core
// Tamper-evident hash chaining & verification
// ============================================

import { createHash } from 'crypto';

export const GENESIS_HASH = 'GENESIS';

export interface AuditHashInput {
  action: string;
  timestamp: string | Date;
  metadata: Record<string, unknown> | string;
  previousHash: string;
}

export interface ChainEvent {
  id?: string;
  action: string;
  actorType?: string;
  actorId?: string;
  entityId?: string;
  metadata: string | Record<string, unknown>;
  previousHash: string;
  hash: string;
  createdAt: string | Date;
}

export interface ChainVerificationResult {
  valid: boolean;
  totalEvents: number;
  brokenAt?: number;
  reason?: string;
}

/**
 * Deterministically serializes metadata with sorted keys
 * to ensure reproducible hashes across platforms and runtimes.
 */
export function serializeMetadata(metadata: Record<string, unknown> | string): string {
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      if (typeof parsed === 'object' && parsed !== null) {
        return JSON.stringify(parsed, Object.keys(parsed).sort());
      }
      return metadata;
    } catch {
      return metadata;
    }
  }
  if (!metadata || typeof metadata !== 'object') {
    return '{}';
  }
  return JSON.stringify(metadata, Object.keys(metadata).sort());
}

/**
 * Computes a SHA-256 hash for an audit event block:
 * `SHA-256(action | timestamp | metadataStr | previousHash)`
 */
export function computeAuditEventHash(input: AuditHashInput): string {
  const ts = input.timestamp instanceof Date ? input.timestamp.toISOString() : input.timestamp;
  const metadataStr = serializeMetadata(input.metadata);
  const hashInput = `${input.action}|${ts}|${metadataStr}|${input.previousHash}`;
  return createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Verifies the mathematical integrity of an entire audit event chain.
 * Checks:
 * 1. Genesis block references GENESIS
 * 2. Each subsequent block's previousHash matches previous block's hash
 * 3. Each block's hash matches the re-computed hash from its content
 */
export function verifyChainIntegrity(events: ChainEvent[]): ChainVerificationResult {
  if (!events || events.length === 0) {
    return { valid: true, totalEvents: 0 };
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const expectedPrevHash = i === 0 ? GENESIS_HASH : events[i - 1].hash;

    // 1. Check previous hash linkage
    if (event.previousHash !== expectedPrevHash) {
      return {
        valid: false,
        totalEvents: events.length,
        brokenAt: i,
        reason: `Previous hash mismatch at index ${i}. Expected '${expectedPrevHash}', got '${event.previousHash}'`,
      };
    }

    // 2. Check hash validity
    const expectedHash = computeAuditEventHash({
      action: event.action,
      timestamp: event.createdAt,
      metadata: event.metadata,
      previousHash: event.previousHash,
    });

    if (event.hash !== expectedHash) {
      return {
        valid: false,
        totalEvents: events.length,
        brokenAt: i,
        reason: `Content hash mismatch at index ${i}. Event payload has been tampered with.`,
      };
    }
  }

  return { valid: true, totalEvents: events.length };
}
