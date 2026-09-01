// ============================================
// AgentBridge - Security Service
// Agent quarantine, escalation, incident tracking
// ============================================

import { createHash, randomBytes } from 'crypto';
import { prisma } from './db.js';
import { recordAuditEvent } from './audit.js';
import { SECURITY_CONFIG } from './security-config.js';
import {
  AuditAction,
  ActorType,
  SecurityViolation,
  QuarantineTrigger,
  SEVERE_SECURITY_EVENTS,
} from '@agentbridge/shared-types';

/**
 * Records a security incident for an agent.
 * Determines severity, increments counters, and triggers escalation.
 *
 * SEVERITY:
 * - SEVERE_SECURITY_EVENTS → CRITICAL severity → triggers escalation
 * - Others → MEDIUM severity
 */
export async function recordSecurityIncident(
  agentId: string,
  type: string,
  description: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const isSevere = SECURITY_CONFIG.SEVERE_VIOLATIONS.includes(type);
  const severity = isSevere ? 'CRITICAL' : 'MEDIUM';

  // Create incident record
  await prisma.securityIncident.create({
    data: {
      agentId,
      type,
      severity,
      description,
      metadata: JSON.stringify(metadata),
    },
  });

  // Update agent counters
  const updateData: Record<string, unknown> = {
    securityViolationCount: { increment: 1 },
    lastSecurityIncidentAt: new Date(),
  };

  if (isSevere) {
    updateData.severeThreatCount = { increment: 1 };
  }

  await prisma.agent.update({
    where: { id: agentId },
    data: updateData as any,
  });

  // Record in audit chain
  await recordAuditEvent({
    action: AuditAction.SECURITY_VIOLATION_DETECTED,
    actorType: ActorType.SYSTEM,
    actorId: 'security-engine',
    entityId: agentId,
    metadata: {
      type,
      severity,
      description,
      isSevere,
      // Never include secrets or sensitive auth details in metadata
    },
  });

  // Trigger escalation checks
  await checkAndEscalate(agentId);
}

/**
 * Checks whether an agent should be quarantined or permanently blocked
 * based on their incident history.
 *
 * Escalation rules (from SECURITY_CONFIG):
 * 1. ≥2 CRITICAL incidents within 10 minutes → QUARANTINE
 * 2. ≥5 total security violations within 24 hours → PERMANENT BLOCK
 */
async function checkAndEscalate(agentId: string): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || agent.status === 'QUARANTINED' || agent.status === 'BLOCKED') {
    return; // Already escalated
  }

  const now = new Date();

  // Check rule 1: Critical incidents in short window → QUARANTINE
  const severeWindowStart = new Date(now.getTime() - SECURITY_CONFIG.TIME_WINDOW_SEVERE_MS);
  const recentCritical = await prisma.securityIncident.count({
    where: {
      agentId,
      severity: 'CRITICAL',
      detectedAt: { gte: severeWindowStart },
    },
  });

  if (recentCritical >= SECURITY_CONFIG.QUARANTINE_SEVERE_INCIDENT_COUNT) {
    await quarantineAgent(
      agentId,
      `Automatically quarantined: ${recentCritical} critical security incidents in ${SECURITY_CONFIG.TIME_WINDOW_SEVERE_MS / 60000} minutes`,
      QuarantineTrigger.SECURITY_VIOLATION
    );
    return;
  }

  // Check rule 2: Total violations in 24h → PERMANENT BLOCK
  const blockWindowStart = new Date(now.getTime() - SECURITY_CONFIG.TIME_WINDOW_BLOCK_MS);
  const recentViolations = await prisma.securityIncident.count({
    where: {
      agentId,
      detectedAt: { gte: blockWindowStart },
    },
  });

  if (recentViolations >= SECURITY_CONFIG.PERMANENT_BLOCK_VIOLATION_COUNT) {
    await blockAgentPermanent(
      agentId,
      `Automatically blocked: ${recentViolations} security incidents in 24 hours`
    );
  }
}

/**
 * Quarantines an agent.
 * All future sensitive requests will be blocked until human review.
 * Does NOT reveal internal threshold details in responses.
 */
export async function quarantineAgent(
  agentId: string,
  reason: string,
  triggeredBy: QuarantineTrigger
): Promise<void> {
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      status: 'QUARANTINED',
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
    metadata: {
      triggeredBy,
      // Do not include internal threshold values — they are for the server only
    },
  });
}

/**
 * Permanently blocks an agent.
 */
export async function blockAgentPermanent(agentId: string, reason: string): Promise<void> {
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      status: 'BLOCKED',
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

/**
 * Unquarantines an agent after human review.
 * Only a merchant admin can perform this action.
 */
export async function unquarantineAgent(agentId: string, reviewedBy: string): Promise<void> {
  await prisma.agent.update({
    where: { id: agentId },
    data: {
      status: 'ACTIVE',
      quarantinedAt: null,
      quarantineReason: null,
      quarantineTriggeredBy: null,
      // Reset severe count but preserve violation count for audit history
      severeThreatCount: 0,
    },
  });

  await recordAuditEvent({
    action: AuditAction.AGENT_UNQUARANTINED,
    actorType: ActorType.MERCHANT,
    actorId: reviewedBy,
    entityId: agentId,
    metadata: { reviewedBy },
  });

  await recordAuditEvent({
    action: AuditAction.AGENT_SECURITY_REVIEWED,
    actorType: ActorType.MERCHANT,
    actorId: reviewedBy,
    entityId: agentId,
    metadata: { action: 'UNQUARANTINE', reviewedBy },
  });
}

/**
 * Generates a new HMAC signing secret for an agent.
 * Returns the secret — caller must store it appropriately.
 * NEVER log this value.
 */
/**
 * Generates a cryptographically secure HMAC signing secret for an agent.
 * Returns the secret — caller must store it appropriately.
 * NEVER log this value.
 */
export function generateAgentSigningSecret(): string {
  // Use CSPRNG (crypto.randomBytes) — never Math.random() for security-critical secrets
  return randomBytes(32).toString('hex');
}
