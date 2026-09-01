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

  // GET /agents - List agents (NEVER expose signingSecret)
  app.get('/agents', async (request, reply) => {
    const agents = await prisma.agent.findMany({
      select: {
        id: true, merchantId: true, name: true, status: true, createdAt: true,
        quarantinedAt: true, quarantineReason: true, quarantineTriggeredBy: true,
        securityViolationCount: true, severeThreatCount: true, lastSecurityIncidentAt: true,
        // signingSecret intentionally excluded
        permissions: true,
      },
    });

    return {
      success: true,
      data: agents.map((a: any) => ({
        ...a,
        permissions: a.permissions.map((p: any) => ({
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

  // ============================================
  // SECURITY DASHBOARD ROUTES
  // ============================================

  // GET /security/overview - Security metrics overview
  app.get('/security/overview', async (request, reply) => {
    const [activeCount, quarantinedCount, blockedCount, incidentCount] = await Promise.all([
      prisma.agent.count({ where: { status: 'ACTIVE' } }),
      prisma.agent.count({ where: { status: 'QUARANTINED' } }),
      prisma.agent.count({ where: { status: 'BLOCKED' } }),
      prisma.securityIncident.count(),
    ]);

    // High threat transactions (score ≥ 60)
    const highThreatAssessments = await prisma.threatAssessmentRecord.findMany({
      where: { score: { gte: 60 } },
      include: {
        purchaseIntent: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    // Recent incidents
    const recentIncidents = await prisma.securityIncident.findMany({
      orderBy: { detectedAt: 'desc' },
      take: 20,
      include: { agent: { select: { id: true, name: true, status: true } } },
    });

    return {
      success: true,
      data: {
        agents: { active: activeCount, quarantined: quarantinedCount, blocked: blockedCount },
        incidents: { total: incidentCount, recent: recentIncidents.map(i => ({
          ...i,
          metadata: JSON.parse(i.metadata || '{}'),
        })) },
        highThreatTransactions: highThreatAssessments.map(t => ({
          ...t,
          factors: JSON.parse(t.factors || '[]'),
        })),
      },
    };
  });

  // GET /security/agents - Agents with full security status
  app.get('/security/agents', async (request, reply) => {
    const agents = await (prisma.agent as any).findMany({
      select: {
        id: true, name: true, status: true, createdAt: true,
        quarantinedAt: true, quarantineReason: true, quarantineTriggeredBy: true,
        securityViolationCount: true, severeThreatCount: true, lastSecurityIncidentAt: true,
        // signingSecret intentionally excluded
        securityIncidents: { orderBy: { detectedAt: 'desc' }, take: 5 },
        threatAssessments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    return {
      success: true,
      data: agents.map((a: any) => ({
        ...a,
        securityIncidents: a.securityIncidents.map((i: any) => ({
          ...i,
          metadata: JSON.parse(i.metadata || '{}'),
        })),
        threatAssessments: a.threatAssessments.map((t: any) => ({
          ...t,
          factors: JSON.parse(t.factors || '[]'),
        })),
      })),
    };
  });

  // GET /security/incidents - All security incidents
  app.get('/security/incidents', async (request, reply) => {
    const incidents = await prisma.securityIncident.findMany({
      orderBy: { detectedAt: 'desc' },
      take: 100,
      include: { agent: { select: { id: true, name: true, status: true } } },
    });

    return {
      success: true,
      data: incidents.map(i => ({
        ...i,
        metadata: JSON.parse(i.metadata || '{}'),
      })),
    };
  });

  // POST /security/agents/:id/unquarantine - Merchant releases agent after review
  app.post('/security/agents/:id/unquarantine', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reviewedBy } = request.body as { reviewedBy?: string };

    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      return reply.status(404).send({ success: false, error: 'Agent not found' });
    }

    if (agent.status !== 'QUARANTINED') {
      return reply.status(400).send({ success: false, error: `Agent is not quarantined (status: ${agent.status})` });
    }

    const { unquarantineAgent } = await import('../security-service.js');
    await unquarantineAgent(id, reviewedBy || 'merchant_admin');

    const updated = await prisma.agent.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, securityViolationCount: true, severeThreatCount: true },
    });

    return { success: true, data: updated };
  });

  // POST /security/agents/:id/block-permanent - Merchant permanently blocks agent
  app.post('/security/agents/:id/block-permanent', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason, blockedBy } = request.body as { reason?: string; blockedBy?: string };

    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      return reply.status(404).send({ success: false, error: 'Agent not found' });
    }

    const { blockAgentPermanent } = await import('../security-service.js');
    await blockAgentPermanent(id, reason || 'Manually blocked by merchant admin');

    const { recordAuditEvent: audit } = await import('../audit.js');
    const { AuditAction: AA, ActorType: AT } = await import('@agentbridge/shared-types');
    await audit({
      action: AA.AGENT_SECURITY_REVIEWED,
      actorType: AT.MERCHANT,
      actorId: blockedBy || 'merchant_admin',
      entityId: id,
      metadata: { action: 'PERMANENT_BLOCK', blockedBy: blockedBy || 'merchant_admin' },
    });

    return { success: true, data: { agentId: id, status: 'BLOCKED' } };
  });
  // ============================================
  // DEMO ENDPOINTS — Hackathon live demonstration
  // ============================================

  /**
   * POST /demo/simulate-attack
   * Simulates a malicious agent attack scenario for live demonstration.
   *
   * Runs a scripted sequence:
   * 1. Creates blocked purchase intents (wrong category / over limit)
   * 2. Triggers replay attack detection
   * 3. Accumulates security incidents until quarantine threshold
   *
   * Returns a step-by-step log of what happened.
   */
  app.post('/demo/simulate-attack', async (request, reply) => {
    const { agentId = 'agent_shopping_01' } = (request.body as any) || {};

    const log: Array<{ step: number; action: string; result: string; timestamp: string }> = [];
    const ts = () => new Date().toISOString();

    const addLog = (step: number, action: string, result: string) => {
      log.push({ step, action, result, timestamp: ts() });
    };

    // Ensure agent is ACTIVE before the attack
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return reply.status(404).send({ success: false, error: `Agent '${agentId}' not found` });
    }

    // Reset agent for clean demo (re-use reset logic)
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        status: 'ACTIVE',
        quarantinedAt: null,
        quarantineReason: null,
        quarantineTriggeredBy: null,
        securityViolationCount: 0,
        severeThreatCount: 0,
        lastSecurityIncidentAt: null,
      },
    });
    addLog(1, 'Agent reset to ACTIVE', `Agent ${agentId} reset to ACTIVE state`);

    // Get a product to use for intents
    const product = await prisma.product.findFirst({
      where: { merchantId: agent.merchantId },
    });
    if (!product) {
      return reply.status(400).send({ success: false, error: 'No products found for demo' });
    }

    // Simulate 6 rapid blocked intents (over-limit purchases)
    let blockedCount = 0;
    for (let i = 0; i < 6; i++) {
      const blockedIntent = await prisma.purchaseIntent.create({
        data: {
          merchantId: agent.merchantId,
          agentId,
          productId: product.id,
          quantity: 1,
          amount: product.price,
          status: 'BLOCKED',
          agentReason: `Demo attack attempt #${i + 1}`,
        },
      });
      blockedCount++;
    }
    addLog(2, `Simulated ${blockedCount} blocked purchase attempts`, `Agent created ${blockedCount} BLOCKED intents — exceeding limits`);

    // Record security incidents directly to simulate EXTREME_REQUEST_FREQUENCY
    const { recordSecurityIncident } = await import('../security-service.js');
    const { SecurityViolation } = await import('@agentbridge/shared-types');

    await recordSecurityIncident(
      agentId,
      SecurityViolation.REPLAY_ATTACK,
      'Demo: simulated replay attack — duplicate request detected',
      { demo: true, step: 3 }
    );
    addLog(3, 'Replay attack simulated', 'REPLAY_ATTACK security violation recorded — CRITICAL incident');

    // Trigger second critical incident to breach quarantine threshold (2 CRITICAL in 10min)
    await recordSecurityIncident(
      agentId,
      SecurityViolation.INVALID_REQUEST_SIGNATURE,
      'Demo: simulated HMAC signature forgery attempt',
      { demo: true, step: 4 }
    );
    addLog(4, 'Signature forgery simulated', 'INVALID_REQUEST_SIGNATURE violation recorded — escalation check triggered');

    // Check final agent status
    const finalAgent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { status: true, quarantineReason: true, securityViolationCount: true, severeThreatCount: true },
    });

    addLog(5, 'Escalation check', `Agent status after attack: ${finalAgent?.status} | Violations: ${finalAgent?.securityViolationCount} | Severe: ${finalAgent?.severeThreatCount}`);

    return {
      success: true,
      data: {
        agentId,
        finalStatus: finalAgent?.status,
        quarantineReason: finalAgent?.quarantineReason,
        securityViolationCount: finalAgent?.securityViolationCount,
        severeThreatCount: finalAgent?.severeThreatCount,
        quarantined: finalAgent?.status === 'QUARANTINED',
        log,
      },
    };
  });

  /**
   * POST /demo/reset
   * Resets the demo agent to ACTIVE state with zeroed security counters.
   * Clears recent intents and incidents for a clean demo loop.
   */
  app.post('/demo/reset', async (request, reply) => {
    const { agentId = 'agent_shopping_01' } = (request.body as any) || {};

    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return reply.status(404).send({ success: false, error: `Agent '${agentId}' not found` });
    }

    // Reset agent security state
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        status: 'ACTIVE',
        quarantinedAt: null,
        quarantineReason: null,
        quarantineTriggeredBy: null,
        securityViolationCount: 0,
        severeThreatCount: 0,
        lastSecurityIncidentAt: null,
      },
    });

    // Clear recent security incidents for this agent
    await prisma.securityIncident.deleteMany({
      where: { agentId },
    });

    // Clear consumed request IDs
    await prisma.consumedRequest.deleteMany({
      where: { agentId },
    });

    // Record reset in audit trail
    const { recordAuditEvent: audit } = await import('../audit.js');
    const { AuditAction: AA, ActorType: AT } = await import('@agentbridge/shared-types');
    await audit({
      action: AA.AGENT_UNQUARANTINED,
      actorType: AT.MERCHANT,
      actorId: 'demo-reset',
      entityId: agentId,
      metadata: { action: 'DEMO_RESET', reason: 'Hackathon demo loop reset' },
    });

    return {
      success: true,
      data: {
        agentId,
        status: 'ACTIVE',
        message: 'Agent reset for demo — all security counters cleared',
      },
    };
  });
}

