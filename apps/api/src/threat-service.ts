// ============================================
// AgentBridge - Threat Service
// Orchestrates behavioral threat analysis with DB queries
// ============================================

import { prisma } from './db.js';
import { parseJsonArray } from './db.js';
import { recordAuditEvent } from './audit.js';
import { recordSecurityIncident, quarantineAgent } from './security-service.js';
import { analyzeThreat } from '@agentbridge/threat-analyzer';
import {
  AuditAction,
  ActorType,
  ThreatAction,
  ThreatLevel,
  ThreatAssessmentResult,
  ThreatContext,
  QuarantineTrigger,
  ThreatRule,
} from '@agentbridge/shared-types';
import { SECURITY_CONFIG } from './security-config.js';

/**
 * Performs a full behavioral threat analysis for a purchase intent.
 *
 * Flow:
 * 1. Query agent's recent behavioral data from DB
 * 2. Build ThreatContext (pure data, no side effects)
 * 3. Call analyzeThreat() (pure function, no DB)
 * 4. Store ThreatAssessmentRecord in DB
 * 5. Record audit events
 * 6. If CRITICAL → trigger quarantine
 * 7. Return ThreatAssessment
 */
export async function performThreatAnalysis(
  agentId: string,
  purchaseIntentId: string,
  currentAmount: number,
  currentCategory: string,
  agentMaxTransactionAmount: number
): Promise<ThreatAssessmentResult> {
  const now = new Date();

  // ---- Query behavioral data ----

  const window60Sec = new Date(now.getTime() - 60 * 1000);
  const window10Min = new Date(now.getTime() - 10 * 60 * 1000);
  const window30Min = new Date(now.getTime() - 30 * 60 * 1000);

  // Recent purchase intents (all statuses) in 10 min for general behavior
  const recentIntents = await prisma.purchaseIntent.findMany({
    where: { agentId, createdAt: { gte: window10Min } },
    orderBy: { createdAt: 'asc' },
    include: { product: true },
  });

  // Request count in last 60 seconds
  const requestCountLast60Sec = await prisma.purchaseIntent.count({
    where: { agentId, createdAt: { gte: window60Sec } },
  });

  // Blocked counts
  const blockedCountLast10Min = await prisma.purchaseIntent.count({
    where: { agentId, status: 'BLOCKED', createdAt: { gte: window10Min } },
  });

  const blockedCountLast30Min = await prisma.purchaseIntent.count({
    where: { agentId, status: 'BLOCKED', createdAt: { gte: window30Min } },
  });

  // Denied approvals in 30 min
  const deniedCountLast30Min = await prisma.approval.count({
    where: {
      status: 'DENIED',
      createdAt: { gte: window30Min },
      purchaseIntent: { agentId },
    },
  });

  // Completed transaction amounts for spending spike check (need ≥3 samples)
  const completedIntents = await prisma.purchaseIntent.findMany({
    where: { agentId, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { amount: true },
  });
  const recentCompletedAmounts = completedIntents.map(i => i.amount);

  // Categories used in last 30 min
  const recentCategoryIntents = await prisma.purchaseIntent.findMany({
    where: { agentId, createdAt: { gte: window30Min } },
    include: { product: true },
  });
  const recentCategories = (recentCategoryIntents as any[])
    .map((i: any) => i.product?.category)
    .filter(Boolean) as string[];

  // Policy failures in last 10 min (BLOCKED intents = policy violated)
  const recentPolicyFailures = recentIntents
    .filter(i => i.status === 'BLOCKED')
    .map(i => ({
      amount: i.amount,
      category: (i as any).product?.category || '',
      createdAt: i.createdAt,
    }));

  // Build ThreatContext
  const ctx: ThreatContext = {
    agentId,
    currentAmount,
    currentCategory,
    agentMaxTransactionAmount,
    requestCountLast60Sec,
    blockedCountLast10Min,
    blockedCountLast30Min,
    deniedCountLast30Min,
    recentCompletedAmounts,
    recentCategories,
    recentPolicyFailures,
    recentPurchaseIntents: recentIntents.map(i => ({
      amount: i.amount,
      status: i.status,
      category: (i as any).product?.category || '',
      createdAt: i.createdAt,
    })),
  };

  // ---- Run analysis (pure function) ----
  const assessment = analyzeThreat(ctx);

  // ---- Store assessment record ----
  await prisma.threatAssessmentRecord.create({
    data: {
      purchaseIntentId,
      agentId,
      score: assessment.score,
      level: assessment.level,
      recommendedAction: assessment.recommendedAction,
      factors: JSON.stringify(assessment.factors),
    },
  });

  // ---- Audit events ----
  await recordAuditEvent({
    action: AuditAction.THREAT_ANALYSIS_COMPLETED,
    actorType: ActorType.SYSTEM,
    actorId: 'threat-analyzer',
    entityId: purchaseIntentId,
    metadata: {
      agentId,
      score: assessment.score,
      level: assessment.level,
      recommendedAction: assessment.recommendedAction,
      factorCount: assessment.factors.length,
      factors: assessment.factors.map(f => ({ rule: f.rule, points: f.points })),
    },
  });

  if (assessment.level === ThreatLevel.HIGH) {
    await recordAuditEvent({
      action: AuditAction.HIGH_THREAT_DETECTED,
      actorType: ActorType.SYSTEM,
      actorId: 'threat-analyzer',
      entityId: purchaseIntentId,
      metadata: { agentId, score: assessment.score, factors: assessment.factors },
    });
  }

  if (assessment.level === ThreatLevel.CRITICAL) {
    await recordAuditEvent({
      action: AuditAction.CRITICAL_THREAT_DETECTED,
      actorType: ActorType.SYSTEM,
      actorId: 'threat-analyzer',
      entityId: purchaseIntentId,
      metadata: { agentId, score: assessment.score, factors: assessment.factors },
    });

    // Check for EXTREME_REQUEST_FREQUENCY (a severe event)
    const hasExtremeFreq = assessment.factors.some(
      f => f.rule === ThreatRule.EXTREME_REQUEST_FREQUENCY
    );
    if (hasExtremeFreq) {
      await recordSecurityIncident(
        agentId,
        ThreatRule.EXTREME_REQUEST_FREQUENCY,
        'Extreme request frequency detected — potential automated attack',
        { score: assessment.score }
      );
    }

    // CRITICAL → auto-quarantine
    await quarantineAgent(
      agentId,
      `Critical behavioral threat detected (score: ${assessment.score}/100)`,
      QuarantineTrigger.AUTOMATIC_THREAT_DETECTION
    );
  }

  return assessment;
}

/**
 * Checks whether a stored ThreatAssessment is still within the validity window.
 * If expired, the caller must re-analyze before executing payment.
 */
export async function isThreatAssessmentValid(purchaseIntentId: string): Promise<{
  valid: boolean;
  assessment: ThreatAssessmentResult | null;
}> {
  const record = await prisma.threatAssessmentRecord.findFirst({
    where: { purchaseIntentId },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) return { valid: false, assessment: null };

  const ageMs = Date.now() - record.createdAt.getTime();
  if (ageMs > SECURITY_CONFIG.THREAT_ASSESSMENT_VALIDITY_MS) {
    return { valid: false, assessment: null };
  }

  return {
    valid: true,
    assessment: {
      score: record.score,
      level: record.level as any,
      recommendedAction: record.recommendedAction as any,
      factors: JSON.parse(record.factors),
      analyzedAt: record.createdAt,
    },
  };
}
