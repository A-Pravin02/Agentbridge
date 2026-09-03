// ============================================
// ADVERSARIAL SUITE
// ============================================
// Assume the agent is malicious, the frontend is compromised, requests are
// replayed, and the attacker knows the API. Everything here is an attack.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import {
  resetDatabase,
  createWorld,
  callAsAgent,
  callAsOwner,
  createAndEvaluate,
  type TestWorld,
} from './helpers.js';

let world: TestWorld;

beforeAll(async () => {
  resetDatabase();
  world = await createWorld();
});

/**
 * Clears the shared agent's incident history between tests.
 *
 * Not a workaround: the controls genuinely compose, and two severe violations
 * inside the escalation window quarantine the agent — which is exactly what
 * the "escalation" block below asserts. Without this reset every test after
 * the first two auth attacks would be refused for THAT reason instead of
 * exercising the control it is meant to prove.
 */
beforeEach(async () => {
  const { prisma } = await import('../src/db.js');
  await prisma.securityIncident.deleteMany({ where: { agentId: world.agent.agentId } });
  await prisma.agent.update({
    where: { id: world.agent.agentId },
    data: { status: 'ACTIVE', severeThreatCount: 0, securityViolationCount: 0, quarantinedAt: null },
  });
});

afterAll(async () => {
  await world.app.close();
  const { prisma } = await import('../src/db.js');
  await prisma.$disconnect();
});

describe('agent authentication', () => {
  it('rejects a completely unsigned request', async () => {
    const res = await world.app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ productId: world.productIds.cheap, quantity: 1 }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request missing ONLY the signature header', async () => {
    // The old build treated a missing header as "skip the check".
    const res = await callAsAgent(
      world,
      'POST',
      '/api/purchase-intents',
      { productId: world.productIds.cheap, quantity: 1, agentReason: 'x' },
      { omitSignature: true }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a request missing ONLY the nonce header', async () => {
    const res = await callAsAgent(
      world,
      'POST',
      '/api/purchase-intents',
      { productId: world.productIds.cheap, quantity: 1, agentReason: 'x' },
      { omitNonce: true }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a signature made with the wrong private key', async () => {
    const { generateAgentKeyPair } = await import('../src/lib/crypto.js');
    const attacker = generateAgentKeyPair();
    const res = await callAsAgent(
      world,
      'POST',
      '/api/purchase-intents',
      { productId: world.productIds.cheap, quantity: 1, agentReason: 'x' },
      { signWith: attacker.privateKey }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a body altered after signing', async () => {
    const res = await callAsAgent(
      world,
      'POST',
      '/api/purchase-intents',
      { productId: world.productIds.cheap, quantity: 1, agentReason: 'x' },
      { tamperBody: { productId: world.productIds.cheap, quantity: 99, agentReason: 'x' } }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp', async () => {
    const res = await callAsAgent(
      world,
      'POST',
      '/api/purchase-intents',
      { productId: world.productIds.cheap, quantity: 1, agentReason: 'x' },
      { timestamp: String(Date.now() - 30 * 60 * 1000) }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a far-future timestamp', async () => {
    const res = await callAsAgent(
      world,
      'POST',
      '/api/purchase-intents',
      { productId: world.productIds.cheap, quantity: 1, agentReason: 'x' },
      { timestamp: String(Date.now() + 30 * 60 * 1000) }
    );
    expect(res.status).toBe(401);
  });

  it('rejects an unknown key id indistinguishably from a bad signature', async () => {
    const res = await world.app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      headers: {
        'content-type': 'application/json',
        'x-agent-key-id': 'ak_does_not_exist',
        'x-request-id': randomUUID(),
        'x-timestamp': String(Date.now()),
        'x-agent-signature': Buffer.alloc(64).toString('base64'),
        'idempotency-key': randomUUID(),
      },
      payload: JSON.stringify({ productId: world.productIds.cheap, quantity: 1 }),
    });
    expect(res.statusCode).toBe(401);
    // No oracle: the message must not reveal that the key is unknown.
    expect(res.json().error).toBe('Request could not be authenticated');
  });

  it('rejects a replayed nonce even with a valid signature', async () => {
    const nonce = randomUUID();
    const body = { productId: world.productIds.cheap, quantity: 1, agentReason: 'replay' };
    const first = await callAsAgent(world, 'POST', '/api/purchase-intents', body, { nonce });
    const second = await callAsAgent(world, 'POST', '/api/purchase-intents', body, { nonce });
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });
});

describe('escalation', () => {
  it('quarantines an agent after repeated severe violations', async () => {
    const w = await createWorld();
    try {
      const { generateAgentKeyPair } = await import('../src/lib/crypto.js');
      const attacker = generateAgentKeyPair();
      const body = { productId: w.productIds.cheap, quantity: 1, agentReason: 'x' };

      // Two forged signatures inside the escalation window.
      await callAsAgent(w, 'POST', '/api/purchase-intents', body, { signWith: attacker.privateKey });
      await callAsAgent(w, 'POST', '/api/purchase-intents', body, { signWith: attacker.privateKey });

      const { prisma } = await import('../src/db.js');
      const agent = await prisma.agent.findUniqueOrThrow({ where: { id: w.agent.agentId } });
      expect(agent.status).toBe('QUARANTINED');

      // A subsequent PERFECTLY VALID request is now refused.
      const valid = await callAsAgent(w, 'POST', '/api/purchase-intents', body);
      expect(valid.status).toBe(403);
    } finally {
      await w.app.close();
    }
  });
});

describe('input validation', () => {
  const cases: Array<[string, unknown]> = [
    ['negative quantity', { quantity: -20 }],
    ['zero quantity', { quantity: 0 }],
    ['fractional quantity', { quantity: 1.5 }],
    ['absurd quantity', { quantity: 1e9 }],
    ['string quantity', { quantity: '5' }],
    ['NaN quantity', { quantity: Number.NaN }],
    ['null product', { productId: null }],
    ['array product', { productId: ['a'] }],
    ['object injection', { productId: { $ne: null } }],
    ['unknown field', { amountMinor: 1 }],
    // JSON.parse creates a real own property named __proto__, unlike an object
    // literal spread, which JS silently discards.
    ['prototype pollution', JSON.parse('{"__proto__":{"polluted":true}}')],
  ];

  for (const [label, override] of cases) {
    it(`rejects ${label}`, async () => {
      const res = await callAsAgent(world, 'POST', '/api/purchase-intents', {
        productId: world.productIds.cheap,
        quantity: 1,
        agentReason: 'validation probe',
        ...(override as Record<string, unknown>),
      });
      expect(res.status).toBe(400);
    });
  }

  it('rejects a malformed JSON body', async () => {
    const res = await world.app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      headers: {
        'content-type': 'application/json',
        'x-agent-key-id': world.agent.keyId,
        'x-request-id': randomUUID(),
        'x-timestamp': String(Date.now()),
        'x-agent-signature': Buffer.alloc(64).toString('base64'),
        'idempotency-key': randomUUID(),
      },
      payload: '{"broken": ',
    });
    expect(res.statusCode).toBe(400);
  });

  it('leaves no negative or zero amount anywhere in the database', async () => {
    const { prisma } = await import('../src/db.js');
    expect(await prisma.purchaseIntent.count({ where: { amountMinor: { lte: 0 } } })).toBe(0);
    expect(await prisma.product.count({ where: { priceMinor: { lt: 0 } } })).toBe(0);
  });
});

describe('idempotency', () => {
  it('requires an idempotency key on mutating routes', async () => {
    const { buildCanonicalRequest, digestBody, signAsAgent } = await import('../src/lib/crypto.js');
    const payload = JSON.stringify({
      productId: world.productIds.cheap,
      quantity: 1,
      agentReason: 'no key',
    });
    const requestId = randomUUID();
    const timestamp = String(Date.now());
    const signature = signAsAgent(
      world.agent.privateKey,
      buildCanonicalRequest({
        keyId: world.agent.keyId,
        requestId,
        timestamp,
        method: 'POST',
        path: '/api/purchase-intents',
        bodyDigest: digestBody(payload),
      })
    );

    const res = await world.app.inject({
      method: 'POST',
      url: '/api/purchase-intents',
      headers: {
        'content-type': 'application/json',
        'x-agent-key-id': world.agent.keyId,
        'x-request-id': requestId,
        'x-timestamp': timestamp,
        'x-agent-signature': signature,
      },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('replays the original result for an identical retry', async () => {
    const w = await createWorld();
    try {
      const key = randomUUID();
      const body = { productId: w.productIds.cheap, quantity: 1, agentReason: 'retry' };
      const first = await callAsAgent(w, 'POST', '/api/purchase-intents', body, {
        idempotencyKey: key,
      });
      const second = await callAsAgent(w, 'POST', '/api/purchase-intents', body, {
        idempotencyKey: key,
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(first.body.data.id);

      const { prisma } = await import('../src/db.js');
      expect(await prisma.purchaseIntent.count({ where: { agentId: w.agent.agentId } })).toBe(1);
    } finally {
      await w.app.close();
    }
  });

  it('20 identical retries create exactly one purchase', async () => {
    const w = await createWorld();
    try {
      const key = randomUUID();
      const body = { productId: w.productIds.cheap, quantity: 1, agentReason: 'hammer' };
      for (let i = 0; i < 20; i++) {
        await callAsAgent(w, 'POST', '/api/purchase-intents', body, { idempotencyKey: key });
      }
      const { prisma } = await import('../src/db.js');
      expect(await prisma.purchaseIntent.count({ where: { agentId: w.agent.agentId } })).toBe(1);
    } finally {
      await w.app.close();
    }
  });

  it('rejects the same key with a different payload', async () => {
    const w = await createWorld();
    try {
      const key = randomUUID();
      await callAsAgent(
        w,
        'POST',
        '/api/purchase-intents',
        { productId: w.productIds.cheap, quantity: 1, agentReason: 'a' },
        { idempotencyKey: key }
      );
      const conflict = await callAsAgent(
        w,
        'POST',
        '/api/purchase-intents',
        { productId: w.productIds.expensive, quantity: 1, agentReason: 'b' },
        { idempotencyKey: key }
      );
      expect(conflict.status).toBe(409);
    } finally {
      await w.app.close();
    }
  });
});

describe('state machine', () => {
  it('refuses to evaluate the same intent twice', async () => {
    const w = await createWorld();
    try {
      const { intentId } = await createAndEvaluate(w, 'cheap');
      const again = await callAsAgent(
        w,
        'POST',
        `/api/purchase-intents/${intentId}/evaluate`,
        {}
      );
      expect(again.status).toBeGreaterThanOrEqual(400);
    } finally {
      await w.app.close();
    }
  });

  it('refuses a payment order before evaluation', async () => {
    const created = await callAsAgent(world, 'POST', '/api/purchase-intents', {
      productId: world.productIds.cheap,
      quantity: 1,
      agentReason: 'skip evaluation',
    });
    const res = await callAsAgent(
      world,
      'POST',
      `/api/purchase-intents/${created.body.data.id}/payment-order`,
      {}
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to settle a purchase with no payment order', async () => {
    const { intentId } = await createAndEvaluate(world, 'cheap');
    const res = await callAsAgent(
      world,
      'POST',
      `/api/purchase-intents/${intentId}/verify-payment`,
      { providerPaymentId: 'pay_x', signature: 'a'.repeat(64) }
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to act on a purchase that is already blocked', async () => {
    const { intentId } = await createAndEvaluate(world, 'expensive');
    const res = await callAsAgent(
      world,
      'POST',
      `/api/purchase-intents/${intentId}/payment-order`,
      {}
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('only lets one of two concurrent payment orders succeed', async () => {
    const w = await createWorld();
    try {
      const { intentId } = await createAndEvaluate(w, 'cheap');
      const results = await Promise.all([
        callAsAgent(w, 'POST', `/api/purchase-intents/${intentId}/payment-order`, {}),
        callAsAgent(w, 'POST', `/api/purchase-intents/${intentId}/payment-order`, {}),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);

      const { prisma } = await import('../src/db.js');
      expect(await prisma.payment.count({ where: { purchaseIntentId: intentId! } })).toBe(1);
    } finally {
      await w.app.close();
    }
  });
});

describe('tenant isolation', () => {
  it("refuses to purchase another merchant's product", async () => {
    const other = await createWorld();
    try {
      const res = await callAsAgent(world, 'POST', '/api/purchase-intents', {
        productId: other.productIds.cheap,
        quantity: 1,
        agentReason: 'cross tenant',
      });
      expect(res.status).toBe(404);
    } finally {
      await other.app.close();
    }
  });

  it("hides another merchant's product from a direct read", async () => {
    const other = await createWorld();
    try {
      const res = await callAsAgent(
        world,
        'GET',
        `/api/products/${other.productIds.cheap}`,
        undefined
      );
      expect(res.status).toBe(404);
    } finally {
      await other.app.close();
    }
  });

  it("excludes other merchants' products from the catalogue listing", async () => {
    const other = await createWorld();
    try {
      const res = await callAsAgent(world, 'GET', '/api/products', undefined);
      const ids = (res.body.data as Array<{ id: string }>).map((p) => p.id);
      expect(ids).not.toContain(other.productIds.cheap);
    } finally {
      await other.app.close();
    }
  });

  it("refuses to read another agent's purchase intent", async () => {
    const other = await createWorld();
    try {
      const created = await callAsAgent(other, 'POST', '/api/purchase-intents', {
        productId: other.productIds.cheap,
        quantity: 1,
        agentReason: 'theirs',
      });
      const res = await callAsAgent(
        world,
        'GET',
        `/api/purchase-intents/${created.body.data.id}`,
        undefined
      );
      expect(res.status).toBe(404);
    } finally {
      await other.app.close();
    }
  });

  it("refuses to evaluate another agent's purchase intent", async () => {
    const other = await createWorld();
    try {
      const created = await callAsAgent(other, 'POST', '/api/purchase-intents', {
        productId: other.productIds.cheap,
        quantity: 1,
        agentReason: 'theirs',
      });
      const res = await callAsAgent(
        world,
        'POST',
        `/api/purchase-intents/${created.body.data.id}/evaluate`,
        {}
      );
      expect(res.status).toBe(404);
    } finally {
      await other.app.close();
    }
  });

  it("scopes the merchant dashboard to the session's own tenant", async () => {
    const other = await createWorld();
    try {
      await createAndEvaluate(other, 'cheap');
      const res = await callAsOwner(world, 'GET', '/api/transactions');
      const agentIds = (res.body.data as Array<{ agent: { id: string } }>).map((t) => t.agent.id);
      expect(agentIds).not.toContain(other.agent.agentId);
    } finally {
      await other.app.close();
    }
  });
});

describe('merchant authentication', () => {
  it('rejects dashboard access with no session', async () => {
    const res = await world.app.inject({ method: 'GET', url: '/api/transactions' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a forged bearer token', async () => {
    const res = await callAsOwner(world, 'GET', '/api/transactions', undefined, 'not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('rejects a revoked session', async () => {
    const w = await createWorld();
    try {
      await callAsOwner(w, 'POST', '/api/auth/logout');
      const res = await callAsOwner(w, 'GET', '/api/transactions');
      expect(res.status).toBe(401);
    } finally {
      await w.app.close();
    }
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const unknown = await world.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@nowhere.test', password: 'whatever-123' },
    });
    const wrongPassword = await world.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@techkart.demo', password: 'wrong-password-123' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknown.json().error).toBe(wrongPassword.json().error);
  });

  it('enforces role separation for policy changes', async () => {
    const w = await createWorld();
    try {
      const { prisma } = await import('../src/db.js');
      const { hashPassword } = await import('../src/lib/crypto.js');
      const viewer = await prisma.merchantUser.create({
        data: {
          merchantId: w.merchantId,
          email: `viewer-${randomUUID().slice(0, 6)}@test.local`,
          passwordHash: await hashPassword('viewer-password-1'),
          role: 'VIEWER',
        },
      });
      const login = await w.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: viewer.email, password: 'viewer-password-1' },
      });
      const viewerToken = login.json().data.token;

      const policy = await callAsOwner(
        w,
        'PATCH',
        '/api/policies',
        { maxTransactionMinor: 999999 },
        viewerToken
      );
      expect(policy.status).toBe(403);

      const approval = await callAsOwner(
        w,
        'POST',
        '/api/purchase-intents/anything/approval',
        { token: 'x'.repeat(32), approve: true },
        viewerToken
      );
      expect(approval.status).toBe(403);
    } finally {
      await w.app.close();
    }
  });
});

describe('webhooks', () => {
  it('rejects an unsigned webhook', async () => {
    const res = await world.app.inject({
      method: 'POST',
      url: '/api/webhooks/razorpay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ event: 'payment.captured', id: 'evt_forged' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a webhook whose body was altered after signing', async () => {
    const { signWebhook } = await import('@agentbridge/payments');
    const original = JSON.stringify({ event: 'payment.captured', id: 'evt_1' });
    const signature = signWebhook(original, process.env.RAZORPAY_WEBHOOK_SECRET!);
    const res = await world.app.inject({
      method: 'POST',
      url: '/api/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      payload: JSON.stringify({ event: 'payment.captured', id: 'evt_TAMPERED' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a replayed webhook delivery', async () => {
    const { signWebhook } = await import('@agentbridge/payments');
    const body = JSON.stringify({ event: 'payment.failed', id: `evt_${randomUUID()}` });
    const signature = signWebhook(body, process.env.RAZORPAY_WEBHOOK_SECRET!);
    const headers = { 'content-type': 'application/json', 'x-razorpay-signature': signature };

    const first = await world.app.inject({ method: 'POST', url: '/api/webhooks/razorpay', headers, payload: body });
    const second = await world.app.inject({ method: 'POST', url: '/api/webhooks/razorpay', headers, payload: body });

    expect(first.json().data.status).not.toBe('DUPLICATE');
    expect(second.json().data.status).toBe('DUPLICATE');
  });
});

describe('audit access control', () => {
  // Regression: /api/audit/events returned the GLOBAL chain to any authenticated
  // merchant, exposing other tenants' actions, entity ids and amounts.
  it("never returns another tenant's audit events", async () => {
    const other = await createWorld();
    try {
      const { recordAuditEvent } = await import('../src/services/audit-service.js');
      await recordAuditEvent({
        action: 'PURCHASE_INTENT_CREATED',
        actorType: 'AGENT',
        actorId: other.agent.agentId,
        entityId: other.merchantId,
        metadata: { note: 'OTHER_TENANT_CONFIDENTIAL' },
      });

      const res = await callAsOwner(world, 'GET', '/api/audit/events');
      expect(JSON.stringify(res.body)).not.toContain('OTHER_TENANT_CONFIDENTIAL');
      expect(JSON.stringify(res.body)).not.toContain(other.merchantId);
    } finally {
      await other.app.close();
    }
  });

  it("still returns the tenant's own audit events", async () => {
    const w = await createWorld();
    try {
      await createAndEvaluate(w, 'cheap');
      const res = await callAsOwner(w, 'GET', '/api/audit/events');
      const actions = (res.body.data as Array<{ action: string }>).map((e) => e.action);
      expect(actions).toContain('POLICY_EVALUATED');
    } finally {
      await w.app.close();
    }
  });
});

describe('budget ledger integrity', () => {
  // Regression: a reservation taken before the persisting transaction was not
  // released if that transaction failed, silently shrinking the agent's
  // remaining headroom for a purchase that never existed.
  it('never holds budget for a purchase that does not exist', async () => {
    const w = await createWorld();
    try {
      const { prisma } = await import('../src/db.js');
      await createAndEvaluate(w, 'cheap');

      const ledger = await prisma.agentDailyLedger.findFirstOrThrow({
        where: { agentId: w.agent.agentId },
      });
      const held = await prisma.purchaseIntent.aggregate({
        where: { agentId: w.agent.agentId, budgetHeld: true },
        _sum: { amountMinor: true },
      });
      // Every reserved paisa is accounted for by an intent that still holds it.
      expect(ledger.reservedMinor).toBe(held._sum.amountMinor ?? 0);
    } finally {
      await w.app.close();
    }
  });

  it('releases budget when a payment fails verification', async () => {
    const w = await createWorld();
    try {
      const { intentId } = await createAndEvaluate(w, 'cheap');
      await callAsAgent(w, 'POST', `/api/purchase-intents/${intentId}/payment-order`, {});
      await callAsAgent(w, 'POST', `/api/purchase-intents/${intentId}/verify-payment`, {
        providerPaymentId: 'pay_never_paid',
        signature: 'f'.repeat(64),
      });

      const { prisma } = await import('../src/db.js');
      const ledger = await prisma.agentDailyLedger.findFirstOrThrow({
        where: { agentId: w.agent.agentId },
      });
      expect(ledger.reservedMinor).toBe(0);
    } finally {
      await w.app.close();
    }
  });
});

describe('information disclosure', () => {
  it('never returns a private key or password hash', async () => {
    const res = await callAsOwner(world, 'GET', '/api/agents');
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/privateKey/i);
    expect(serialized).not.toMatch(/passwordHash/i);
    expect(serialized).not.toMatch(/signingSecret/i);
  });

  it('does not leak internal detail in a 500-class response', async () => {
    const res = await callAsAgent(
      world,
      'GET',
      '/api/purchase-intents/definitely-not-a-real-id',
      undefined
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|sql|stack|at Object/i);
  });

  it('attaches a request id to errors for correlation', async () => {
    const res = await world.app.inject({ method: 'GET', url: '/api/transactions' });
    expect(res.json().requestId).toBeTruthy();
  });
});

describe('rate limiting', () => {
  // Regression: the limiter was originally keyed on X-Agent-Key-Id, which runs
  // BEFORE authentication and is therefore attacker-controlled. Varying the
  // header gave a fresh bucket per request and the limiter did nothing at all
  // (15/15 passed a limit of 5). It is now keyed on IP.
  it('cannot be bypassed by varying an attacker-controlled header', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { buildServer } = await import('../src/server.js');
    const app = await buildServer(loadConfig({ ...process.env, RATE_LIMIT_MAX: '5' } as never));
    await app.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 15; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/health',
          headers: { 'x-agent-key-id': `ak_${Math.random().toString(36).slice(2)}` },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toContain(429);
    } finally {
      await app.close();
    }
  });

  it('limits unauthenticated request floods', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { buildServer } = await import('../src/server.js');
    const app = await buildServer(loadConfig({ ...process.env, RATE_LIMIT_MAX: '5' } as never));
    await app.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await app.inject({ method: 'GET', url: '/api/health' });
        codes.push(res.statusCode);
      }
      expect(codes).toContain(429);
    } finally {
      await app.close();
    }
  });
});
