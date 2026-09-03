// ============================================
// AgentBridge - Security Service
// ============================================
// Incident recording, escalation, quarantine.

import { prisma, type Db } from '../db.js';
import { recordAuditEvent } from './audit-service.js';
import {
  AuditAction,
  ActorType,
  AgentStatus,
  QuarantineTrigger,
  SEVERE_SECURITY_EVENTS,
} from '@agentbridge/shared-types';

export const ESCALATION = {
  /** Severe incidents within the window that trigger quarantine. */
  SEVERE_COUNT: 2,
  SEVERE_WINDOW_MS: 10 * 60 * 1000,
  /** Total incidents within the window that trigger a permanent block. */
  TOTAL_COUNT: 8,
  TOTAL_WINDOW_MS: 24 * 60 * 60 * 1000,
} as const;

export function isSevere(type: string): boolean {
  return SEVERE_SECURITY_EVENTS.includes(type);
}

/**
 * Records a security incident and runs escalation.
 *
 * Never throws: a failure to record an incident must not convert a *refused*
 * request into a *successful* one. Callers refuse first and record after.
 */
export async function recordSecurityIncident(params: {
  agentId: string;
  type: string;
  description: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { agentId, type, description, metadata = {} } = params;
  try {
    const severe = isSevere(type);

    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
    if (!agent) return; // Unknown agent: nothing to attribute the incident to.

    await prisma.$transaction(async (tx) => {
      await tx.securityIncident.create({
        data: {
          agentId,
          type,
          severity: severe ? 'CRITICAL' : 'MEDIUM',
          description,
          metadata: JSON.stringify(metadata),
        },
      });
      await tx.agent.update({
        where: { id: agentId },
        data: {
          securityViolationCount: { increment: 1 },
          severeThreatCount: severe ? { increment: 1 } : undefined,
          lastSecurityIncidentAt: new Date(),
        },
      });
    });

    await recordAuditEvent({
      action: AuditAction.SECURITY_VIOLATION_DETECTED,
      actorType: ActorType.SYSTEM,
      actorId: 'security-engine',
      entityId: agentId,
      // Never log secrets, signatures, tokens or raw bodies.
      metadata: { type, severity: severe ? 'CRITICAL' : 'MEDIUM', description },
    });

    await escalate(agentId);
  } catch {
    // Swallowed deliberately — see the doc comment above.
  }
}

async function escalate(agentId: string): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return;
  if (agent.status === AgentStatus.QUARANTINED || agent.status === AgentStatus.BLOCKED) return;

  const now = Date.now();

  const severeRecent = await prisma.securityIncident.count({
    where: {
      agentId,
      severity: 'CRITICAL',
      detectedAt: { gte: new Date(now - ESCALATION.SEVERE_WINDOW_MS) },
    },
  });
  if (severeRecent >= ESCALATION.SEVERE_COUNT) {
    await quarantineAgent(
      agentId,
      `${severeRecent} critical security incidents within ${ESCALATION.SEVERE_WINDOW_MS / 60000} minutes`,
      QuarantineTrigger.SECURITY_VIOLATION
    );
    return;
  }

  const totalRecent = await prisma.securityIncident.count({
    where: { agentId, detectedAt: { gte: new Date(now - ESCALATION.TOTAL_WINDOW_MS) } },
  });
  if (totalRecent >= ESCALATION.TOTAL_COUNT) {
    await blockAgentPermanently(agentId, `${totalRecent} security incidents within 24 hours`);
  }
}

export async function quarantineAgent(
  agentId: string,
  reason: string,
  triggeredBy: QuarantineTrigger,
  db: Db = prisma
): Promise<void> {
  await db.agent.update({
    where: { id: agentId },
    data: {
      status: AgentStatus.QUARANTINED,
      quarantinedAt: new Date(),
      quarantineReason: reason,
      quarantineTriggeredBy: triggeredBy,
    },
  });
  await recordAuditEvent({
    action: AuditAction.AGENT_QUARANTINED,
    actorType: ActorType.SYSTEM,
    actorId: 'security-engine',
    entityId: agentId,
    // The reason is stored on the agent for operators; the audit metadata
    // carries only the trigger class, not internal threshold values.
    metadata: { triggeredBy },
  });
}

export async function blockAgentPermanently(agentId: string, reason: string): Promise<void> {
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      status: AgentStatus.BLOCKED,
      quarantineReason: reason,
      quarantineTriggeredBy: QuarantineTrigger.AUTOMATIC_THREAT_DETECTION,
    },
  });
  await recordAuditEvent({
    action: AuditAction.AGENT_BLOCKED_PERMANENT,
    actorType: ActorType.SYSTEM,
    actorId: 'security-engine',
    entityId: agentId,
    metadata: {},
  });
}

/** Human review outcome. Requires an authenticated merchant user. */
export async function unquarantineAgent(agentId: string, reviewedBy: string): Promise<void> {
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      status: AgentStatus.ACTIVE,
      quarantinedAt: null,
      quarantineReason: null,
      quarantineTriggeredBy: null,
      severeThreatCount: 0,
    },
  });
  await recordAuditEvent({
    action: AuditAction.AGENT_UNQUARANTINED,
    actorType: ActorType.MERCHANT_USER,
    actorId: reviewedBy,
    entityId: agentId,
    metadata: { reviewedBy },
  });
}
