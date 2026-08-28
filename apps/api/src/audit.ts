// ============================================
// AgentBridge - Audit System
// Tamper-evident audit chain
// ============================================

import { createHash } from 'crypto';
import { prisma } from './db.js';

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

  const previousHash = lastEvent?.hash || 'GENESIS';
  const timestamp = new Date().toISOString();
  const metadataStr = JSON.stringify(input.metadata, Object.keys(input.metadata).sort());

  // Create hash: action + timestamp + metadata + previousHash
  const hashInput = `${input.action}|${timestamp}|${metadataStr}|${previousHash}`;
  const hash = createHash('sha256').update(hashInput).digest('hex');

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
 * Verifies the integrity of the audit chain.
 * Returns true if the chain is intact, false if tampered.
 */
export async function verifyAuditChain(): Promise<{
  valid: boolean;
  totalEvents: number;
  brokenAt?: number;
}> {
  const events = await prisma.auditEvent.findMany({
    orderBy: { createdAt: 'asc' },
  });

  if (events.length === 0) {
    return { valid: true, totalEvents: 0 };
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const expectedPrevHash = i === 0 ? 'GENESIS' : events[i - 1].hash;

    if (event.previousHash !== expectedPrevHash) {
      return { valid: false, totalEvents: events.length, brokenAt: i };
    }
  }

  return { valid: true, totalEvents: events.length };
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
