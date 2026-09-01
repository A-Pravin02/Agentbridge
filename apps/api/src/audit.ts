// ============================================
// AgentBridge - Audit System
// Tamper-evident audit chain using @agentbridge/audit
// ============================================

import { prisma } from './db.js';
import { computeAuditEventHash, serializeMetadata, verifyChainIntegrity, GENESIS_HASH } from '@agentbridge/audit';

interface AuditInput {
  action: string;
  actorType: string;
  actorId: string;
  entityId: string;
  metadata: Record<string, unknown>;
}

/**
 * Records an audit event with a hash chain.
 * Each event's hash includes the previous event's hash,
 * creating a tamper-evident chain.
 */
export async function recordAuditEvent(input: AuditInput) {
  // Get the last audit event for the hash chain
  const lastEvent = await prisma.auditEvent.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  const previousHash = lastEvent?.hash || GENESIS_HASH;
  const timestamp = new Date().toISOString();
  const metadataStr = serializeMetadata(input.metadata);

  // Compute hash using pure @agentbridge/audit engine
  const hash = computeAuditEventHash({
    action: input.action,
    timestamp,
    metadata: metadataStr,
    previousHash,
  });

  const event = await prisma.auditEvent.create({
    data: {
      action: input.action,
      actorType: input.actorType,
      actorId: input.actorId,
      entityId: input.entityId,
      metadata: metadataStr,
      previousHash,
      hash,
    },
  });

  return event;
}

/**
 * Verifies the integrity of the audit chain using @agentbridge/audit.
 * Returns true if the chain is intact, false if tampered.
 */
export async function verifyAuditChain(): Promise<{
  valid: boolean;
  totalEvents: number;
  brokenAt?: number;
  reason?: string;
}> {
  const events = await prisma.auditEvent.findMany({
    orderBy: { createdAt: 'asc' },
  });

  return verifyChainIntegrity(events.map(e => ({
    id: e.id,
    action: e.action,
    actorType: e.actorType,
    actorId: e.actorId,
    entityId: e.entityId,
    metadata: e.metadata,
    previousHash: e.previousHash,
    hash: e.hash,
    createdAt: e.createdAt,
  })));
}

/**
 * Gets all audit events for a specific entity (e.g., purchase intent)
 * for transaction replay.
 */
export async function getAuditTrail(entityId: string) {
  return prisma.auditEvent.findMany({
    where: { entityId },
    orderBy: { createdAt: 'asc' },
  });
}
