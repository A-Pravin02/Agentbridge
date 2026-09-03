// ============================================
// SECURITY INVARIANTS
// ============================================
//
// Ten properties that must hold no matter what any client does. The Phase 0
// audit found eight of the ten violated. Each is now an executable test
// against the real server — if any of these ever goes red, the project's core
// claim is false and CI must fail.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import {
  resetDatabase,
  createWorld,
  callAsAgent,
  callAsOwner,
  createAndEvaluate,
  completePurchase,
  type TestWorld,
} from './helpers.js';

let world: TestWorld;

beforeAll(async () => {
  resetDatabase();
  world = await createWorld();
});

afterAll(async () => {
  await world.app.close();
  const { prisma } = await import('../src/db.js');
  await prisma.$disconnect();
});

describe('INVARIANT 1 — a BLOCK can never result in a payment', () => {
  it('refuses to create a payment order for a blocked purchase', async () => {
    const { intentId, evaluated } = await createAndEvaluate(world, 'expensive');
    expect(evaluated!.body.data.decision).toBe('BLOCK');

    const order = await callAsAgent(
      world,
      'POST',
      `/api/purchase-intents/${intentId}/payment-order`,
      {}
    );
    expect(order.status).toBeGreaterThanOrEqual(400);

    const { prisma } = await import('../src/db.js');
    expect(await prisma.payment.count({ where: { purchaseIntentId: intentId! } })).toBe(0);
  });

  it('leaves no BLOCKED intent with any payment row, across the whole database', async () => {
    const { prisma } = await import('../src/db.js');
    const offenders = await prisma.purchaseIntent.findMany({
      where: { status: 'BLOCKED', payments: { some: {} } },
    });
    expect(offenders).toHaveLength(0);
  });
});

describe('INVARIANT 2 — an agent can never exceed its daily limit', () => {
  it('holds under sequential spending', async () => {
    const w = await createWorld({ maxDailyMinor: 100000, maxTransactionsPerDay: 100 }); // ₹1000
    try {
      // ₹299 each: four fit (₹1196), the fifth would reach ₹1495.
      const decisions: string[] = [];
      for (let i = 0; i < 6; i++) {
        const { evaluated } = await createAndEvaluate(w, 'cheap');
        decisions.push(evaluated!.body.data.decision);
      }
      expect(decisions.filter((d) => d === 'ALLOW')).toHaveLength(3);

      const { prisma } = await import('../src/db.js');
      const ledger = await prisma.agentDailyLedger.findFirst({ where: { agentId: w.agent.agentId } });
      expect(ledger!.reservedMinor).toBeLessThanOrEqual(100000);
    } finally {
      await w.app.close();
    }
  });

  it('HOLDS UNDER CONCURRENCY — the attack that used to breach the cap', async () => {
    const w = await createWorld({ maxDailyMinor: 200000, maxTransactionsPerDay: 100 }); // ₹2000
    try {
      // Create ten intents, then evaluate all of them simultaneously.
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const created = await callAsAgent(w, 'POST', '/api/purchase-intents', {
          productId: w.productIds.cheap,
          quantity: 1,
          agentReason: 'race',
        });
        ids.push(created.body.data.id);
      }

      const results = await Promise.all(
        ids.map((id) => callAsAgent(w, 'POST', `/api/purchase-intents/${id}/evaluate`, {}))
      );
      const allowed = results.filter((r) => r.body?.data?.decision === 'ALLOW').length;

      const { prisma } = await import('../src/db.js');
      const ledger = await prisma.agentDailyLedger.findFirst({ where: { agentId: w.agent.agentId } });

      // ₹2000 / ₹299 = 6 maximum.
      expect(allowed).toBe(6);
      expect(ledger!.reservedMinor).toBe(6 * 29900);
      expect(ledger!.reservedMinor).toBeLessThanOrEqual(200000);
    } finally {
      await w.app.close();
    }
  });

  it('holds the transaction-count cap under concurrency', async () => {
    const w = await createWorld({ maxDailyMinor: 10_000_000, maxTransactionsPerDay: 3 });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const c = await callAsAgent(w, 'POST', '/api/purchase-intents', {
          productId: w.productIds.cheap,
          quantity: 1,
          agentReason: 'race',
        });
        ids.push(c.body.data.id);
      }
      await Promise.all(
        ids.map((id) => callAsAgent(w, 'POST', `/api/purchase-intents/${id}/evaluate`, {}))
      );
      const { prisma } = await import('../src/db.js');
      const ledger = await prisma.agentDailyLedger.findFirst({ where: { agentId: w.agent.agentId } });
      expect(ledger!.txnCount).toBeLessThanOrEqual(3);
    } finally {
      await w.app.close();
    }
  });
});

describe('INVARIANT 3 — a revoked agent can never transact', () => {
  it('refuses every request once quarantined', async () => {
    const w = await createWorld();
    try {
      const { prisma } = await import('../src/db.js');
      await prisma.agent.update({
        where: { id: w.agent.agentId },
        data: { status: 'QUARANTINED' },
      });

      const created = await callAsAgent(w, 'POST', '/api/purchase-intents', {
        productId: w.productIds.cheap,
        quantity: 1,
        agentReason: 'after revocation',
      });
      expect(created.status).toBe(403);
      expect(await prisma.purchaseIntent.count({ where: { agentId: w.agent.agentId } })).toBe(0);
    } finally {
      await w.app.close();
    }
  });

  it('refuses to settle an already-authorized purchase after revocation', async () => {
    const w = await createWorld();
    try {
      const { intentId } = await createAndEvaluate(w, 'cheap');
      const { prisma } = await import('../src/db.js');
      await prisma.agent.update({ where: { id: w.agent.agentId }, data: { status: 'BLOCKED' } });

      const order = await callAsAgent(
        w,
        'POST',
        `/api/purchase-intents/${intentId}/payment-order`,
        {}
      );
      expect(order.status).toBe(403);
    } finally {
      await w.app.close();
    }
  });
});

describe('INVARIANT 4 — no completion without a verified payment', () => {
  it('rejects a forged payment signature and never reaches COMPLETED', async () => {
    const { intentId } = await createAndEvaluate(world, 'cheap');
    await callAsAgent(world, 'POST', `/api/purchase-intents/${intentId}/payment-order`, {});

    const forged = await callAsAgent(
      world,
      'POST',
      `/api/purchase-intents/${intentId}/verify-payment`,
      { providerPaymentId: 'pay_ATTACKER_NEVER_PAID', signature: 'f'.repeat(64) }
    );
    expect(forged.status).toBe(403);

    const { prisma } = await import('../src/db.js');
    const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId! } });
    expect(intent!.status).not.toBe('COMPLETED');
  });

  it('accepts a genuine provider signature', async () => {
    const w = await createWorld();
    try {
      const { settled } = await completePurchase(w, 'cheap');
      expect(settled.status).toBe(200);
      expect(settled.body.data.status).toBe('COMPLETED');
    } finally {
      await w.app.close();
    }
  });

  it('leaves no COMPLETED intent without a VERIFIED payment, database-wide', async () => {
    const { prisma } = await import('../src/db.js');
    const completed = await prisma.purchaseIntent.findMany({
      where: { status: 'COMPLETED' },
      include: { payments: true },
    });
    for (const intent of completed) {
      expect(intent.payments.some((p) => p.status === 'VERIFIED')).toBe(true);
    }
  });
});

describe('INVARIANT 5 — one payment cannot settle two transactions', () => {
  it('rejects reuse of a provider payment id', async () => {
    const w = await createWorld();
    try {
      const first = await completePurchase(w, 'cheap');
      expect(first.settled.status).toBe(200);

      // A second purchase, settled with the FIRST payment's identifier.
      const { intentId: secondId } = await createAndEvaluate(w, 'cheap');
      const order = await callAsAgent(
        w,
        'POST',
        `/api/purchase-intents/${secondId}/payment-order`,
        {}
      );
      const { signPayment } = await import('@agentbridge/payments');
      const signature = signPayment(
        order.body.data.providerOrderId,
        first.paymentId,
        process.env.RAZORPAY_KEY_SECRET!
      );

      const replay = await callAsAgent(
        w,
        'POST',
        `/api/purchase-intents/${secondId}/verify-payment`,
        { providerPaymentId: first.paymentId, signature }
      );
      expect(replay.status).toBeGreaterThanOrEqual(400);

      const { prisma } = await import('../src/db.js');
      const settledWithThatPayment = await prisma.payment.count({
        where: { providerPaymentId: first.paymentId, status: 'VERIFIED' },
      });
      expect(settledWithThatPayment).toBe(1);
    } finally {
      await w.app.close();
    }
  });
});

describe('INVARIANT 6 — an approval cannot be reused', () => {
  it('rejects a replayed approval decision', async () => {
    const w = await createWorld();
    try {
      const { intentId, evaluated } = await createAndEvaluate(w, 'approval');
      expect(evaluated!.body.data.decision).toBe('REQUIRE_APPROVAL');
      const token = evaluated!.body.data.approval.token as string;

      const first = await callAsOwner(w, 'POST', `/api/purchase-intents/${intentId}/approval`, {
        token,
        approve: true,
      });
      expect(first.status).toBe(200);

      const second = await callAsOwner(w, 'POST', `/api/purchase-intents/${intentId}/approval`, {
        token,
        approve: true,
      });
      expect(second.status).toBeGreaterThanOrEqual(400);
    } finally {
      await w.app.close();
    }
  });

  it('rejects an approval decision with a wrong token', async () => {
    const w = await createWorld();
    try {
      const { intentId } = await createAndEvaluate(w, 'approval');
      const res = await callAsOwner(w, 'POST', `/api/purchase-intents/${intentId}/approval`, {
        token: 'x'.repeat(43),
        approve: true,
      });
      expect(res.status).toBe(403);
    } finally {
      await w.app.close();
    }
  });

  it('rejects an expired approval', async () => {
    const w = await createWorld();
    try {
      const { intentId, evaluated } = await createAndEvaluate(w, 'approval');
      const token = evaluated!.body.data.approval.token as string;

      const { prisma } = await import('../src/db.js');
      await prisma.approval.updateMany({
        where: { purchaseIntentId: intentId! },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await callAsOwner(w, 'POST', `/api/purchase-intents/${intentId}/approval`, {
        token,
        approve: true,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('APPROVAL_EXPIRED');
    } finally {
      await w.app.close();
    }
  });
});

describe('INVARIANT 7 — a client can never override the authoritative price', () => {
  it('ignores any client-supplied amount field', async () => {
    const created = await callAsAgent(world, 'POST', '/api/purchase-intents', {
      productId: world.productIds.cheap,
      quantity: 1,
      agentReason: 'price manipulation',
      // Extra fields are rejected outright by the strict schema.
      amountMinor: 1,
      priceMinor: 1,
    } as Record<string, unknown>);
    expect(created.status).toBe(400);
  });

  it('derives the amount from the database price', async () => {
    const created = await callAsAgent(world, 'POST', '/api/purchase-intents', {
      productId: world.productIds.cheap,
      quantity: 2,
      agentReason: 'authoritative pricing',
    });
    expect(created.body.data.amountMinor).toBe(2 * 29900);
  });

  it('re-derives the amount at evaluation if the catalogue price changed', async () => {
    const w = await createWorld();
    try {
      const created = await callAsAgent(w, 'POST', '/api/purchase-intents', {
        productId: w.productIds.cheap,
        quantity: 1,
        agentReason: 'stale price',
      });
      const intentId = created.body.data.id;

      const { prisma } = await import('../src/db.js');
      await prisma.product.update({
        where: { id: w.productIds.cheap },
        data: { priceMinor: 34900 },
      });

      await callAsAgent(w, 'POST', `/api/purchase-intents/${intentId}/evaluate`, {});
      const after = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
      // The agent asked at ₹299; the server charges the current ₹349.
      expect(after!.amountMinor).toBe(34900);
    } finally {
      await w.app.close();
    }
  });

  it('rejects a negative quantity and stores nothing', async () => {
    const res = await callAsAgent(world, 'POST', '/api/purchase-intents', {
      productId: world.productIds.expensive,
      quantity: -20,
      agentReason: 'budget inflation',
    });
    expect(res.status).toBe(400);

    const { prisma } = await import('../src/db.js');
    expect(await prisma.purchaseIntent.count({ where: { amountMinor: { lt: 0 } } })).toBe(0);
  });
});

describe('INVARIANT 8 — an agent cannot approve its own transaction', () => {
  it('rejects an unauthenticated approval', async () => {
    const { intentId, evaluated } = await createAndEvaluate(world, 'approval');
    const token = evaluated!.body.data.approval.token as string;

    const res = await world.app.inject({
      method: 'POST',
      url: `/api/purchase-intents/${intentId}/approval`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token, approve: true }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an approval signed with agent credentials', async () => {
    const { intentId, evaluated } = await createAndEvaluate(world, 'approval');
    const token = evaluated!.body.data.approval.token as string;
    const res = await callAsAgent(
      world,
      'POST',
      `/api/purchase-intents/${intentId}/approval`,
      { token, approve: true }
    );
    // Agent credentials are not a merchant session.
    expect(res.status).toBe(401);
  });

  it("rejects another merchant's user approving this transaction", async () => {
    const other = await createWorld();
    try {
      const { intentId, evaluated } = await createAndEvaluate(world, 'approval');
      const token = evaluated!.body.data.approval.token as string;
      const res = await callAsOwner(
        world,
        'POST',
        `/api/purchase-intents/${intentId}/approval`,
        { token, approve: true },
        other.ownerToken // a valid session, wrong tenant
      );
      expect(res.status).toBe(404);
    } finally {
      await other.app.close();
    }
  });
});

describe('INVARIANT 9 — audit tampering is always detected', () => {
  it('verifies a clean chain', async () => {
    const res = await callAsOwner(world, 'POST', '/api/audit/verify');
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.totalEvents).toBeGreaterThan(0);
  });

  it('detects a modified event payload', async () => {
    const { prisma } = await import('../src/db.js');
    const victim = await prisma.auditEvent.findFirst({ orderBy: { sequence: 'asc' } });
    const original = victim!.metadata;

    await prisma.auditEvent.update({
      where: { id: victim!.id },
      data: { metadata: JSON.stringify({ amountMinor: 1, tampered: true }) },
    });
    const during = await callAsOwner(world, 'POST', '/api/audit/verify');
    expect(during.body.data.valid).toBe(false);
    expect(during.body.data.breakReason).toBe('CONTENT_HASH_MISMATCH');

    await prisma.auditEvent.update({ where: { id: victim!.id }, data: { metadata: original } });
    const after = await callAsOwner(world, 'POST', '/api/audit/verify');
    expect(after.body.data.valid).toBe(true);
  });

  it('detects a rewritten actor', async () => {
    const { prisma } = await import('../src/db.js');
    const victim = await prisma.auditEvent.findFirst({ orderBy: { sequence: 'desc' } });
    const original = victim!.actorId;

    await prisma.auditEvent.update({
      where: { id: victim!.id },
      data: { actorId: 'someone_else' },
    });
    expect((await callAsOwner(world, 'POST', '/api/audit/verify')).body.data.valid).toBe(false);

    await prisma.auditEvent.update({ where: { id: victim!.id }, data: { actorId: original } });
    expect((await callAsOwner(world, 'POST', '/api/audit/verify')).body.data.valid).toBe(true);
  });

  it('detects a deleted event', async () => {
    const { prisma } = await import('../src/db.js');
    const victim = await prisma.auditEvent.findFirst({
      orderBy: { sequence: 'asc' },
      skip: 2,
    });
    const snapshot = { ...victim! };
    await prisma.auditEvent.delete({ where: { id: victim!.id } });

    const result = await callAsOwner(world, 'POST', '/api/audit/verify');
    expect(result.body.data.valid).toBe(false);

    await prisma.auditEvent.create({ data: snapshot });
    expect((await callAsOwner(world, 'POST', '/api/audit/verify')).body.data.valid).toBe(true);
  });

  it('records an audit event for every state change', async () => {
    const w = await createWorld();
    try {
      const { intentId } = await createAndEvaluate(w, 'cheap');
      const { prisma } = await import('../src/db.js');
      const events = await prisma.auditEvent.findMany({ where: { entityId: intentId! } });
      const actions = events.map((e) => e.action);
      expect(actions).toContain('PURCHASE_INTENT_CREATED');
      expect(actions).toContain('POLICY_EVALUATED');
      expect(actions).toContain('PURCHASE_ALLOWED');
      expect(actions).toContain('BUDGET_RESERVED');
    } finally {
      await w.app.close();
    }
  });
});

describe('INVARIANT 10 — decisions are reproducible', () => {
  it('records the policy version and decision id for every decision', async () => {
    // Its own world: the shared one has by now accumulated enough severe
    // violations from earlier invariants to be legitimately quarantined, which
    // is itself correct behaviour (see INVARIANT 3).
    const w = await createWorld();
    try {
      const { intentId } = await createAndEvaluate(w, 'cheap');
      const { prisma } = await import('../src/db.js');
      const auth = await prisma.authorization.findFirstOrThrow({
        where: { purchaseIntentId: intentId! },
      });
      expect(auth.policyVersion).toBe(1);
      expect(auth.decisionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(auth.evaluatedRules)).toHaveLength(15);
    } finally {
      await w.app.close();
    }
  });

  it('re-evaluating the same context yields the identical verdict', async () => {
    const { evaluatePolicy } = await import('@agentbridge/policy-engine');
    const { prisma } = await import('../src/db.js');
    const { loadPolicyState } = await import('../src/services/policy-service.js');
    const { AgentStatus, ThreatLevel } = await import('@agentbridge/shared-types');

    const state = await loadPolicyState(world.agent.agentId, world.merchantId);
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: world.productIds.cheap },
    });

    const context = {
      decisionId: 'fixed',
      now: new Date('2026-09-03T10:00:00Z'),
      request: {
        merchantId: world.merchantId,
        agentId: world.agent.agentId,
        productId: product.id,
        productCategory: product.category,
        amountMinor: product.priceMinor,
        currency: 'INR',
        quantity: 1,
        agentReason: 'replay',
      },
      agentStatus: AgentStatus.ACTIVE,
      permission: state.passport,
      merchantPolicy: state.merchantPolicy,
      usage: { dailySpentMinor: 0, dailyTransactionCount: 0, countLastMinute: 0 },
      risk: { score: 10, level: ThreatLevel.LOW },
    };

    const first = evaluatePolicy(context as never);
    const second = evaluatePolicy(context as never);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('preserves a snapshot of the old policy when it changes', async () => {
    const w = await createWorld();
    try {
      await callAsOwner(w, 'PATCH', '/api/policies', { maxTransactionMinor: 100000 });
      const { prisma } = await import('../src/db.js');
      const versions = await prisma.policyVersion.findMany();
      expect(versions.length).toBeGreaterThan(0);
      expect(JSON.parse(versions[0].snapshot).maxTransactionMinor).toBe(50000);

      const policy = await prisma.policy.findFirstOrThrow({ where: { merchantId: w.merchantId } });
      expect(policy.version).toBe(2);
    } finally {
      await w.app.close();
    }
  });
});
