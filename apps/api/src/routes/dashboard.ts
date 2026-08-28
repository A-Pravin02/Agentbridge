// ============================================
// AgentBridge - Dashboard & Misc Routes
// Transaction listing, audit, policies, dashboard stats
// ============================================

import { FastifyInstance } from 'fastify';
import { prisma, parseJsonArray } from '../db.js';
import { getAuditTrail, verifyAuditChain } from '../audit.js';

export async function dashboardRoutes(app: FastifyInstance) {
  // GET /dashboard/stats - Dashboard statistics
  app.get('/dashboard/stats', async (request, reply) => {
    const { merchantId } = request.query as { merchantId?: string };
    const where = merchantId ? { merchantId } : {};

    const [total, allowed, blocked, requireApproval, completed] = await Promise.all([
      prisma.purchaseIntent.count({ where }),
      prisma.purchaseIntent.count({ where: { ...where, status: 'AUTHORIZED' } }),
      prisma.purchaseIntent.count({ where: { ...where, status: 'BLOCKED' } }),
      prisma.purchaseIntent.count({ where: { ...where, status: 'REQUIRE_APPROVAL' } }),
      prisma.purchaseIntent.count({ where: { ...where, status: 'COMPLETED' } }),
    ]);

    const completedIntents = await prisma.purchaseIntent.findMany({
      where: { ...where, status: 'COMPLETED' },
    });
    const totalValue = completedIntents.reduce((sum, i) => sum + i.amount, 0);

    const recentActivity = await prisma.auditEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      success: true,
      data: {
        totalTransactions: total,
        allowedTransactions: allowed + completed,
        blockedTransactions: blocked,
        approvalRequests: requireApproval,
        completedTransactions: completed,
        totalTransactionValue: totalValue,
        recentActivity: recentActivity.map(e => ({
          ...e,
          metadata: JSON.parse(e.metadata || '{}'),
        })),
      },
    };
  });

  // GET /transactions - List all transactions
  app.get('/transactions', async (request, reply) => {
    const intents = await prisma.purchaseIntent.findMany({
      include: {
        product: true,
        authorizations: true,
        transactions: true,
        approvals: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, data: intents };
  });

  // GET /transactions/:id/replay - Transaction replay
  app.get('/transactions/:id/replay', async (request, reply) => {
    const { id } = request.params as { id: string };

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      include: {
        product: true,
        agent: true,
        authorizations: true,
        approvals: true,
        transactions: true,
      },
    });

    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Transaction not found' });
    }

    const auditTrail = await getAuditTrail(id);

    return {
      success: true,
      data: {
        purchaseIntent: intent,
        auditTrail: auditTrail.map(e => ({
          ...e,
          metadata: JSON.parse(e.metadata || '{}'),
        })),
      },
    };
  });

  // GET /audit-events - List all audit events
  app.get('/audit-events', async (request, reply) => {
    const events = await prisma.auditEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      success: true,
      data: events.map(e => ({
        ...e,
        metadata: JSON.parse(e.metadata || '{}'),
      })),
    };
  });

  // GET /audit/verify - Verify audit chain integrity
  app.get('/audit/verify', async (request, reply) => {
    const result = await verifyAuditChain();
    return { success: true, data: result };
  });

  // GET /policies - Get merchant policies
  app.get('/policies', async (request, reply) => {
    const { merchantId } = request.query as { merchantId?: string };
    const where = merchantId ? { merchantId } : {};

    const policies = await prisma.policy.findMany({ where });

    return {
      success: true,
      data: policies.map(p => ({
        ...p,
        allowedCategories: parseJsonArray(p.allowedCategories),
      })),
    };
  });

  // PUT /policies/:id - Update policy
  app.put('/policies/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;

    const updateData: Record<string, unknown> = {};
    if (body.maxTransactionAmount !== undefined) updateData.maxTransactionAmount = body.maxTransactionAmount;
    if (body.maxDailyAmount !== undefined) updateData.maxDailyAmount = body.maxDailyAmount;
    if (body.maxTransactionsPerDay !== undefined) updateData.maxTransactionsPerDay = body.maxTransactionsPerDay;
    if (body.approvalThreshold !== undefined) updateData.approvalThreshold = body.approvalThreshold;
    if (body.allowedCategories !== undefined) {
      updateData.allowedCategories = JSON.stringify(body.allowedCategories);
    }

    const policy = await prisma.policy.update({
      where: { id },
      data: updateData,
    });

    return {
      success: true,
      data: {
        ...policy,
        allowedCategories: parseJsonArray(policy.allowedCategories),
      },
    };
  });

  // GET /agents - List agents
  app.get('/agents', async (request, reply) => {
    const agents = await prisma.agent.findMany({
      include: { permissions: true },
    });

    return {
      success: true,
      data: agents.map(a => ({
        ...a,
        permissions: a.permissions.map(p => ({
          ...p,
          allowedCategories: parseJsonArray(p.allowedCategories),
        })),
      })),
    };
  });

  // GET /approvals/pending - Get pending approvals
  app.get('/approvals/pending', async (request, reply) => {
    const approvals = await prisma.approval.findMany({
      where: { status: 'PENDING' },
      include: {
        purchaseIntent: {
          include: { product: true, agent: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { success: true, data: approvals };
  });
}
