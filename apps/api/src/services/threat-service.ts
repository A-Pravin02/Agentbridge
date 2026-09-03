// ============================================
// AgentBridge - Threat Service
// ============================================
// Gathers behavioural data, calls the pure analyzer, persists the assessment.
// All I/O lives here; the analyzer itself stays pure and unit-testable.

import { prisma, type Db } from '../db.js';
import { analyzeThreat } from '@agentbridge/threat-analyzer';
import {
  AuditAction,
  ActorType,
  ThreatLevel,
  ThreatRule,
  PurchaseStatus,
  SecurityViolation,
  type ThreatAssessmentResult,
  type ThreatContext,
  type Minor,
} from '@agentbridge/shared-types';
import { recordAuditEvent } from './audit-service.js';
import { recordSecurityIncident } from './security-service.js';

export const THREAT_ASSESSMENT_TTL_MS = 5 * 60 * 1000;

export async function performThreatAnalysis(params: {
  agentId: string;
  purchaseIntentId: string;
  amountMinor: Minor;
  category: string;
  agentMaxTransactionMinor: Minor;
  now?: Date;
}): Promise<ThreatAssessmentResult> {
  const now = params.now ?? new Date();
  const { agentId, purchaseIntentId, amountMinor, category, agentMaxTransactionMinor } = params;

  const w60s = new Date(now.getTime() - 60_000);
  const w10m = new Date(now.getTime() - 10 * 60_000);
  const w30m = new Date(now.getTime() - 30 * 60_000);

  // Batched so one evaluation costs one round trip rather than seven.
  const [
    recentIntents,
    requestCountLast60Sec,
    blockedCountLast10Min,
    blockedCountLast30Min,
    deniedCountLast30Min,
    completed,
    categoryIntents,
  ] = await prisma.$transaction([
    prisma.purchaseIntent.findMany({
      where: { agentId, createdAt: { gte: w10m } },
      orderBy: { createdAt: 'asc' },
      include: { product: { select: { category: true } } },
    }),
    prisma.purchaseIntent.count({ where: { agentId, createdAt: { gte: w60s } } }),
    prisma.purchaseIntent.count({
      where: { agentId, status: PurchaseStatus.BLOCKED, createdAt: { gte: w10m } },
    }),
    prisma.purchaseIntent.count({
      where: { agentId, status: PurchaseStatus.BLOCKED, createdAt: { gte: w30m } },
    }),
    prisma.approval.count({
      where: { status: 'DENIED', createdAt: { gte: w30m }, purchaseIntent: { agentId } },
    }),
    prisma.purchaseIntent.findMany({
      where: { agentId, status: PurchaseStatus.COMPLETED },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { amountMinor: true },
    }),
    prisma.purchaseIntent.findMany({
      where: { agentId, createdAt: { gte: w30m } },
      include: { product: { select: { category: true } } },
    }),
  ]);

  const ctx: ThreatContext = {
    agentId,
    now,
    currentAmountMinor: amountMinor,
    currentCategory: category,
    agentMaxTransactionMinor,
    requestCountLast60Sec,
    blockedCountLast10Min,
    blockedCountLast30Min,
    deniedCountLast30Min,
    recentCompletedAmountsMinor: completed.map((i) => i.amountMinor),
    recentCategories: categoryIntents.map((i) => i.product?.category ?? '').filter(Boolean),
    recentPolicyFailures: recentIntents
      .filter((i) => i.status === PurchaseStatus.BLOCKED)
      .map((i) => ({
        amountMinor: i.amountMinor,
        category: i.product?.category ?? '',
        createdAt: i.createdAt,
      })),
    recentPurchaseIntents: recentIntents.map((i) => ({
      amountMinor: i.amountMinor,
      status: i.status,
      category: i.product?.category ?? '',
      createdAt: i.createdAt,
    })),
  };

  const assessment = analyzeThreat(ctx);

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

  await recordAuditEvent({
    action: AuditAction.THREAT_ANALYSIS_COMPLETED,
    actorType: ActorType.SYSTEM,
    actorId: 'threat-analyzer',
    entityId: purchaseIntentId,
    metadata: {
      agentId,
      score: assessment.score,
      level: assessment.level,
      factors: assessment.factors.map((f) => ({ rule: f.rule, points: f.points })),
    },
  });

  if (assessment.level === ThreatLevel.HIGH || assessment.level === ThreatLevel.CRITICAL) {
    await recordAuditEvent({
      action:
        assessment.level === ThreatLevel.CRITICAL
          ? AuditAction.CRITICAL_THREAT_DETECTED
          : AuditAction.HIGH_THREAT_DETECTED,
      actorType: ActorType.SYSTEM,
      actorId: 'threat-analyzer',
      entityId: purchaseIntentId,
      metadata: { agentId, score: assessment.score, factors: assessment.factors },
    });
  }

  // An extreme request rate is an attack signal, not merely a risky purchase.
  if (assessment.factors.some((f) => f.rule === ThreatRule.EXTREME_REQUEST_FREQUENCY)) {
    await recordSecurityIncident({
      agentId,
      type: SecurityViolation.EXTREME_REQUEST_FREQUENCY,
      description: 'Extreme request frequency — probable automated attack',
      metadata: { score: assessment.score },
    });
  }

  return assessment;
}

/**
 * Returns the stored assessment if it is still fresh.
 *
 * Callers MUST act on a stale result by re-analysing and honouring the new
 * verdict. The audit found the old code re-analysed and then discarded
 * everything short of QUARANTINE; the purchase service now feeds the fresh
 * score back through the policy engine instead.
 */
export async function getFreshAssessment(
  purchaseIntentId: string,
  now: Date = new Date(),
  db: Db = prisma
): Promise<{ fresh: boolean; assessment: ThreatAssessmentResult | null }> {
  const record = await db.threatAssessmentRecord.findFirst({
    where: { purchaseIntentId },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) return { fresh: false, assessment: null };

  const assessment: ThreatAssessmentResult = {
    score: record.score,
    level: record.level as ThreatLevel,
    recommendedAction: record.recommendedAction,
    factors: JSON.parse(record.factors),
    analyzedAt: record.createdAt,
  };
  const age = now.getTime() - record.createdAt.getTime();
  return { fresh: age <= THREAT_ASSESSMENT_TTL_MS, assessment };
}
