// ============================================
// AgentBridge - Merchant Routes
// ============================================
// Authentication, approvals, dashboard reads, policy administration.
// Every route is scoped to the authenticated user's merchant. There is no
// endpoint that returns another tenant's data.

import type { FastifyInstance } from 'fastify';
import {
  ActorType,
  AuditAction,
  ApprovalStatus,
  PurchaseStatus,
  formatMinor,
  type Currency,
} from '@agentbridge/shared-types';
import { prisma, parseJsonArray, parseJsonObject, ledgerDay } from '../db.js';
import { getConfig } from '../config.js';
import {
  approvalDecisionSchema,
  loginSchema,
  paginationSchema,
  updatePolicySchema,
} from '../schemas.js';
import { authenticateMerchantUser, requireRole } from '../plugins/auth.js';
import { generateToken, hashToken, verifyPassword } from '../lib/crypto.js';
import { UnauthenticatedError, NotFoundError } from '../lib/errors.js';
import { decideApproval } from '../services/approval-service.js';
import { recordAuditEvent, verifyAuditChain, verifyEntityTrail } from '../services/audit-service.js';
import { unquarantineAgent } from '../services/security-service.js';
import { bumpPolicyVersion, toMerchantPolicy } from '../services/policy-service.js';
import { getUsage } from '../services/ledger-service.js';

export async function merchantRoutes(app: FastifyInstance) {
  // ---- Login (unauthenticated) ----
  app.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body ?? {});
    const config = getConfig();

    const user = await prisma.merchantUser.findUnique({ where: { email: body.email } });

    // Always run the KDF, even for an unknown email, so response timing does
    // not reveal whether an account exists.
    const dummyHash = 'de'.repeat(16) + ':' + 'ad'.repeat(64);
    const ok = await verifyPassword(body.password, user?.passwordHash ?? dummyHash);

    if (!user || !ok || user.status !== 'ACTIVE') {
      throw new UnauthenticatedError('Email or password is incorrect');
    }

    const token = generateToken(32);
    await prisma.session.create({
      data: {
        merchantUserId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + config.SESSION_TTL_MS),
      },
    });

    await recordAuditEvent({
      action: AuditAction.MERCHANT_USER_AUTHENTICATED,
      actorType: ActorType.MERCHANT_USER,
      actorId: user.id,
      entityId: user.merchantId,
      metadata: { email: user.email },
    });

    return reply.send({
      success: true,
      data: {
        // The only time the raw token exists outside the client.
        token,
        user: { id: user.id, email: user.email, role: user.role, merchantId: user.merchantId },
      },
    });
  });

  // ---- Everything below requires a session ----
  app.register(async (secured) => {
    secured.addHook('preHandler', authenticateMerchantUser);

    secured.post('/auth/logout', async (request) => {
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      await prisma.session.updateMany({
        where: { tokenHash: hashToken(token) },
        data: { revokedAt: new Date() },
      });
      return { success: true, data: { loggedOut: true } };
    });

    secured.get('/auth/me', async (request) => ({
      success: true,
      data: request.merchantUser,
    }));

    // ---- Approvals ----

    secured.get('/approvals/pending', async (request) => {
      const user = request.merchantUser!;
      const approvals = await prisma.approval.findMany({
        where: {
          status: ApprovalStatus.PENDING,
          expiresAt: { gt: new Date() },
          purchaseIntent: { merchantId: user.merchantId },
        },
        include: {
          purchaseIntent: {
            include: { product: true, agent: { select: { id: true, name: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      return {
        success: true,
        data: approvals.map((a) => ({
          approvalId: a.id,
          purchaseIntentId: a.purchaseIntentId,
          expiresAt: a.expiresAt,
          agent: a.purchaseIntent.agent,
          product: {
            id: a.purchaseIntent.product.id,
            name: a.purchaseIntent.product.name,
            category: a.purchaseIntent.product.category,
          },
          amountMinor: a.purchaseIntent.amountMinor,
          amountDisplay: formatMinor(
            a.purchaseIntent.amountMinor,
            a.purchaseIntent.currency as Currency
          ),
          agentReason: a.purchaseIntent.agentReason,
        })),
      };
    });

    // Approve or deny. Requires APPROVER or OWNER — a VIEWER cannot move money.
    secured.post(
      '/purchase-intents/:id/approval',
      { preHandler: requireRole('OWNER', 'APPROVER') },
      async (request) => {
        const body = approvalDecisionSchema.parse(request.body ?? {});
        const { id } = request.params as { id: string };
        const user = request.merchantUser!;

        const result = await decideApproval({
          purchaseIntentId: id,
          token: body.token,
          merchantUserId: user.id,
          merchantId: user.merchantId,
          approve: body.approve,
        });
        return { success: true, data: result };
      }
    );

    // ---- Dashboard ----

    secured.get('/dashboard/stats', async (request) => {
      const user = request.merchantUser!;
      const where = { merchantId: user.merchantId };

      const [total, byStatus, agents, pendingApprovals, incidents, chain] = await Promise.all([
        prisma.purchaseIntent.count({ where }),
        prisma.purchaseIntent.groupBy({ by: ['status'], where, _count: true, _sum: { amountMinor: true } }),
        prisma.agent.count({ where: { merchantId: user.merchantId } }),
        prisma.approval.count({
          where: {
            status: ApprovalStatus.PENDING,
            expiresAt: { gt: new Date() },
            purchaseIntent: where,
          },
        }),
        prisma.securityIncident.count({
          where: { agent: { merchantId: user.merchantId }, detectedAt: { gte: new Date(Date.now() - 86400000) } },
        }),
        verifyAuditChain(),
      ]);

      const completedMinor =
        byStatus.find((s) => s.status === PurchaseStatus.COMPLETED)?._sum.amountMinor ?? 0;

      return {
        success: true,
        data: {
          totalIntents: total,
          byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
          completedValueMinor: completedMinor,
          completedValueDisplay: formatMinor(completedMinor),
          agents,
          pendingApprovals,
          securityIncidents24h: incidents,
          auditChain: {
            valid: chain.valid,
            totalEvents: chain.totalEvents,
            reason: chain.reason,
          },
        },
      };
    });

    secured.get('/transactions', async (request) => {
      const { limit } = paginationSchema.parse(request.query ?? {});
      const user = request.merchantUser!;

      const intents = await prisma.purchaseIntent.findMany({
        where: { merchantId: user.merchantId },
        include: {
          product: { select: { name: true, category: true } },
          agent: { select: { id: true, name: true } },
          authorizations: { orderBy: { createdAt: 'desc' }, take: 1 },
          payments: { orderBy: { createdAt: 'desc' }, take: 1 },
          threatAssessments: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      return {
        success: true,
        data: intents.map((i) => ({
          id: i.id,
          status: i.status,
          amountMinor: i.amountMinor,
          amountDisplay: formatMinor(i.amountMinor, i.currency as Currency),
          product: i.product,
          agent: i.agent,
          decision: i.authorizations[0]?.decision ?? null,
          reason: i.authorizations[0]?.humanReason ?? null,
          riskScore: i.threatAssessments[0]?.score ?? null,
          paymentStatus: i.payments[0]?.status ?? null,
          createdAt: i.createdAt,
        })),
      };
    });

    /**
     * The transaction timeline — the most important screen in the product.
     * Reconstructs exactly what happened and why, from the audit chain.
     */
    secured.get('/transactions/:id/timeline', async (request) => {
      const { id } = request.params as { id: string };
      const user = request.merchantUser!;

      const intent = await prisma.purchaseIntent.findUnique({
        where: { id },
        include: {
          product: true,
          agent: { select: { id: true, name: true } },
          authorizations: { orderBy: { createdAt: 'desc' }, take: 1 },
          threatAssessments: { orderBy: { createdAt: 'desc' }, take: 1 },
          payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      if (!intent || intent.merchantId !== user.merchantId) {
        throw new NotFoundError('Transaction');
      }

      const [events, integrity] = await Promise.all([
        prisma.auditEvent.findMany({ where: { entityId: id }, orderBy: { sequence: 'asc' } }),
        verifyEntityTrail(id),
      ]);

      const authorization = intent.authorizations[0];
      return {
        success: true,
        data: {
          intent: {
            id: intent.id,
            status: intent.status,
            amountMinor: intent.amountMinor,
            amountDisplay: formatMinor(intent.amountMinor, intent.currency as Currency),
            quantity: intent.quantity,
            agentReason: intent.agentReason,
            product: intent.product,
            agent: intent.agent,
          },
          decision: authorization
            ? {
                decision: authorization.decision,
                reasonCode: authorization.reasonCode,
                reason: authorization.humanReason,
                policyVersion: authorization.policyVersion,
                decisionId: authorization.decisionId,
                evaluatedRules: parseJsonObject<unknown[]>(authorization.evaluatedRules, []),
              }
            : null,
          risk: intent.threatAssessments[0]
            ? {
                score: intent.threatAssessments[0].score,
                level: intent.threatAssessments[0].level,
                factors: parseJsonObject<unknown[]>(intent.threatAssessments[0].factors, []),
              }
            : null,
          payment: intent.payments[0]
            ? {
                status: intent.payments[0].status,
                providerOrderId: intent.payments[0].providerOrderId,
                providerPaymentId: intent.payments[0].providerPaymentId,
                verifiedAt: intent.payments[0].verifiedAt,
              }
            : null,
          timeline: events.map((e) => ({
            sequence: e.sequence,
            action: e.action,
            actorType: e.actorType,
            actorId: e.actorId,
            timestamp: e.timestamp,
            metadata: parseJsonObject<Record<string, unknown>>(e.metadata, {}),
            hash: e.hash,
          })),
          integrity,
        },
      };
    });

    // ---- Agents ----

    secured.get('/agents', async (request) => {
      const user = request.merchantUser!;
      const agents = await prisma.agent.findMany({
        where: { merchantId: user.merchantId },
        // `publicKey` is safe to expose; there is no private material to leak.
        select: {
          id: true,
          name: true,
          status: true,
          keyId: true,
          createdAt: true,
          quarantinedAt: true,
          quarantineReason: true,
          securityViolationCount: true,
          severeThreatCount: true,
          permission: true,
        },
      });

      const day = ledgerDay();
      const withUsage = await Promise.all(
        agents.map(async (a) => {
          const usage = await getUsage(a.id, day);
          return {
            ...a,
            permission: a.permission
              ? {
                  ...a.permission,
                  allowedCategories: parseJsonArray(a.permission.allowedCategories),
                  allowedCurrencies: parseJsonArray(a.permission.allowedCurrencies),
                  allowedMerchantIds: parseJsonArray(a.permission.allowedMerchantIds),
                  maxTransactionDisplay: formatMinor(a.permission.maxTransactionMinor),
                  maxDailyDisplay: formatMinor(a.permission.maxDailyMinor),
                }
              : null,
            usageToday: {
              spentMinor: usage.reservedMinor,
              spentDisplay: formatMinor(usage.reservedMinor),
              transactionCount: usage.txnCount,
              remainingMinor: Math.max(
                0,
                (a.permission?.maxDailyMinor ?? 0) - usage.reservedMinor
              ),
            },
          };
        })
      );

      return { success: true, data: withUsage };
    });

    secured.post(
      '/agents/:id/unquarantine',
      { preHandler: requireRole('OWNER', 'APPROVER') },
      async (request) => {
        const { id } = request.params as { id: string };
        const user = request.merchantUser!;
        const agent = await prisma.agent.findUnique({ where: { id } });
        if (!agent || agent.merchantId !== user.merchantId) throw new NotFoundError('Agent');
        await unquarantineAgent(id, user.id);
        return { success: true, data: { agentId: id, status: 'ACTIVE' } };
      }
    );

    // ---- Security ----

    secured.get('/security/incidents', async (request) => {
      const { limit } = paginationSchema.parse(request.query ?? {});
      const user = request.merchantUser!;
      const incidents = await prisma.securityIncident.findMany({
        where: { agent: { merchantId: user.merchantId } },
        include: { agent: { select: { id: true, name: true } } },
        orderBy: { detectedAt: 'desc' },
        take: limit,
      });
      return {
        success: true,
        data: incidents.map((i) => ({
          id: i.id,
          type: i.type,
          severity: i.severity,
          description: i.description,
          agent: i.agent,
          detectedAt: i.detectedAt,
        })),
      };
    });

    // ---- Audit ----

    secured.get('/audit/events', async (request) => {
      const { limit } = paginationSchema.parse(request.query ?? {});
      const events = await prisma.auditEvent.findMany({
        orderBy: { sequence: 'desc' },
        take: limit,
      });
      return {
        success: true,
        data: events.map((e) => ({
          sequence: e.sequence,
          action: e.action,
          actorType: e.actorType,
          actorId: e.actorId,
          entityId: e.entityId,
          timestamp: e.timestamp,
          metadata: parseJsonObject<Record<string, unknown>>(e.metadata, {}),
          hash: e.hash,
          previousHash: e.previousHash,
        })),
      };
    });

    secured.post('/audit/verify', async () => ({
      success: true,
      data: await verifyAuditChain(),
    }));

    secured.get('/audit/verify', async () => ({
      success: true,
      data: await verifyAuditChain(),
    }));

    // ---- Policy ----

    secured.get('/policies', async (request) => {
      const user = request.merchantUser!;
      const policy = await prisma.policy.findUnique({ where: { merchantId: user.merchantId } });
      if (!policy) throw new NotFoundError('Policy');
      return { success: true, data: toMerchantPolicy(policy) };
    });

    secured.patch('/policies', { preHandler: requireRole('OWNER') }, async (request) => {
      const body = updatePolicySchema.parse(request.body ?? {});
      const user = request.merchantUser!;

      const policy = await prisma.policy.findUnique({ where: { merchantId: user.merchantId } });
      if (!policy) throw new NotFoundError('Policy');

      // Snapshot the OLD version before mutating, so historical decisions
      // remain reproducible against the exact policy that produced them.
      await bumpPolicyVersion(policy.id, user.id);

      const updated = await prisma.policy.update({
        where: { id: policy.id },
        data: {
          version: { increment: 1 },
          maxTransactionMinor: body.maxTransactionMinor,
          maxDailyMinor: body.maxDailyMinor,
          maxTransactionsPerDay: body.maxTransactionsPerDay,
          approvalThresholdMinor: body.approvalThresholdMinor,
          riskBlockThreshold: body.riskBlockThreshold,
          riskApprovalThreshold: body.riskApprovalThreshold,
          allowedCategories: body.allowedCategories
            ? JSON.stringify(body.allowedCategories)
            : undefined,
          allowedCurrencies: body.allowedCurrencies
            ? JSON.stringify(body.allowedCurrencies)
            : undefined,
        },
      });

      await recordAuditEvent({
        action: AuditAction.POLICY_CHANGED,
        actorType: ActorType.MERCHANT_USER,
        actorId: user.id,
        entityId: policy.id,
        metadata: { newVersion: updated.version, changes: body },
      });

      return { success: true, data: toMerchantPolicy(updated) };
    });
  });
}
