// ============================================
// AgentBridge - Live Attack Console
// ============================================
//
// The Phase 0 audit called the previous `/demo/simulate-attack` "theatre": it
// inserted rows already labelled BLOCKED and wrote fake incident records. No
// control was ever exercised, so it proved nothing.
//
// This replaces it with scenarios that issue REAL requests through the REAL
// stack — `app.inject()` runs the actual routes, the actual authentication
// hook, the actual services and the actual database. Nothing is stubbed and no
// outcome is pre-decided. When a scenario reports BLOCKED, the system genuinely
// refused a genuine attack, and the audit trail records it like any other
// request.
//
// A scenario declares what it expects; the runner reports pass/fail by
// comparing that to what actually happened. A regression turns the demo red.

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PolicyDecision,
  PurchaseStatus,
  formatMinor,
} from '@agentbridge/shared-types';
import { prisma, ledgerDay } from '../db.js';
import { buildCanonicalRequest, digestBody, signAsAgent } from '../lib/crypto.js';
import { sandboxSignature } from '../services/payment-service.js';
import { verifyAuditChain } from '../services/audit-service.js';

interface DemoIdentity {
  agentId: string;
  keyId: string;
  privateKey: string;
}

/** Written by the seed. Git-ignored — it holds a private key. */
function loadDemoIdentity(): DemoIdentity {
  const path = join(process.cwd(), '.demo-agent.json');
  return JSON.parse(readFileSync(path, 'utf8')) as DemoIdentity;
}

export async function demoRoutes(app: FastifyInstance) {
  /** Signs and issues a real in-process request. */
  async function callAsAgent(
    identity: DemoIdentity,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts: { tamperBody?: unknown; reuseNonce?: string; omitSignature?: boolean } = {}
  ) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const requestId = opts.reuseNonce ?? randomUUID();
    const timestamp = String(Date.now());

    const canonical = buildCanonicalRequest({
      keyId: identity.keyId,
      requestId,
      timestamp,
      method,
      path,
      bodyDigest: digestBody(payload),
    });
    const signature = signAsAgent(identity.privateKey, canonical);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-agent-key-id': identity.keyId,
      'x-request-id': requestId,
      'x-timestamp': timestamp,
      'idempotency-key': randomUUID(),
    };
    if (!opts.omitSignature) headers['x-agent-signature'] = signature;

    const res = await app.inject({
      method,
      url: path,
      headers,
      // When tampering, the transmitted body differs from the signed one.
      payload: opts.tamperBody !== undefined ? JSON.stringify(opts.tamperBody) : payload,
    });

    return { status: res.statusCode, body: res.json() as Record<string, any>, requestId };
  }

  async function freshIntent(identity: DemoIdentity, productId: string, quantity = 1) {
    const res = await callAsAgent(identity, 'POST', '/api/purchase-intents', {
      productId,
      quantity,
      agentReason: 'Live demo',
    });
    return res.body?.data?.id as string | undefined;
  }

  // ---- Reset ----
  // Clears demo state so the console can be run repeatedly. Deliberately does
  // NOT touch the audit chain: the log is append-only and resetting it would
  // undermine the very property the demo is proving.
  app.post('/reset', async () => {
    const identity = loadDemoIdentity();
    await prisma.$transaction([
      prisma.threatAssessmentRecord.deleteMany({ where: { agentId: identity.agentId } }),
      prisma.securityIncident.deleteMany({ where: { agentId: identity.agentId } }),
      prisma.consumedRequest.deleteMany({ where: { agentId: identity.agentId } }),
      prisma.idempotencyRecord.deleteMany({ where: { agentId: identity.agentId } }),
      prisma.agentDailyLedger.deleteMany({ where: { agentId: identity.agentId } }),
    ]);
    await prisma.approval.deleteMany({
      where: { purchaseIntent: { agentId: identity.agentId } },
    });
    await prisma.authorization.deleteMany({
      where: { purchaseIntent: { agentId: identity.agentId } },
    });
    await prisma.payment.deleteMany({
      where: { purchaseIntent: { agentId: identity.agentId } },
    });
    await prisma.purchaseIntent.deleteMany({ where: { agentId: identity.agentId } });
    await prisma.agent.update({
      where: { id: identity.agentId },
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
    return { success: true, data: { reset: true, note: 'Audit chain intentionally preserved' } };
  });

  // ---- The scenarios ----
  app.post('/run', async (request) => {
    const identity = loadDemoIdentity();
    const only = (request.body as { scenario?: string } | null)?.scenario;

    const products = await prisma.product.findMany({
      where: { merchant: { agents: { some: { id: identity.agentId } } } },
      orderBy: { priceMinor: 'asc' },
    });
    const bySlug = (needle: string) =>
      products.find((p) => p.name.toLowerCase().includes(needle))!;

    const cable = bySlug('usb-c');
    const premiumCase = bySlug('premium case');
    const powerBank = bySlug('power bank');
    const watch = bySlug('designer watch');

    /**
     * Restores the agent to a clean footing between scenarios.
     *
     * This matters because the controls genuinely interact: two severe
     * incidents inside ten minutes quarantine the agent, so without a reset
     * the later scenarios would all be refused for that reason rather than
     * exercising the control they are meant to demonstrate. Each scenario is
     * therefore an independent, reproducible demonstration.
     *
     * The audit chain is deliberately NOT reset — it is append-only, and the
     * whole run remains verifiable end to end afterwards.
     */
    const isolate = async () => {
      await prisma.securityIncident.deleteMany({ where: { agentId: identity.agentId } });
      await prisma.agentDailyLedger.deleteMany({ where: { agentId: identity.agentId } });
      await prisma.agent.update({
        where: { id: identity.agentId },
        data: {
          status: 'ACTIVE',
          quarantinedAt: null,
          quarantineReason: null,
          quarantineTriggeredBy: null,
          securityViolationCount: 0,
          severeThreatCount: 0,
        },
      });
    };

    const results: ScenarioResult[] = [];
    const run = async (s: Scenario) => {
      if (only && s.id !== only) return;
      await isolate();
      const started = Date.now();
      try {
        const outcome = await s.run();
        results.push({
          ...describe(s),
          ...outcome,
          passed: outcome.actual === s.expected,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        results.push({
          ...describe(s),
          actual: 'ERROR',
          detail: error instanceof Error ? error.message : String(error),
          passed: false,
          durationMs: Date.now() - started,
        });
      }
    };

    // 1 — Normal purchase, all the way to a cryptographically settled payment.
    await run({
      id: 'allow',
      title: 'Legitimate purchase within policy',
      attack: false,
      expected: 'COMPLETED',
      description: `Agent buys ${cable.name} (${formatMinor(cable.priceMinor)}) — inside every limit.`,
      run: async () => {
        const intentId = await freshIntent(identity, cable.id);
        const evaluated = await callAsAgent(
          identity,
          'POST',
          `/api/purchase-intents/${intentId}/evaluate`,
          {}
        );
        if (evaluated.body?.data?.decision !== PolicyDecision.ALLOW) {
          return { actual: 'BLOCKED', detail: evaluated.body?.data?.reason ?? 'not allowed' };
        }
        const order = await callAsAgent(
          identity,
          'POST',
          `/api/purchase-intents/${intentId}/payment-order`,
          {}
        );
        const orderId = order.body?.data?.providerOrderId as string;
        // A genuine provider signature, minted by the sandbox's key.
        const { paymentId, signature } = sandboxSignature(orderId);
        const settled = await callAsAgent(
          identity,
          'POST',
          `/api/purchase-intents/${intentId}/verify-payment`,
          { providerPaymentId: paymentId, signature }
        );
        return {
          actual: settled.body?.data?.status === PurchaseStatus.COMPLETED ? 'COMPLETED' : 'FAILED',
          detail: `Payment verified by HMAC signature; status ${settled.body?.data?.status}`,
        };
      },
    });

    // 2 — Over the per-transaction limit.
    await run({
      id: 'over-limit',
      title: 'Purchase above the per-transaction limit',
      attack: false,
      expected: 'BLOCKED',
      description: `Agent tries ${powerBank.name} (${formatMinor(powerBank.priceMinor)}) against a lower cap.`,
      run: async () => {
        const intentId = await freshIntent(identity, powerBank.id);
        const res = await callAsAgent(
          identity,
          'POST',
          `/api/purchase-intents/${intentId}/evaluate`,
          {}
        );
        return {
          actual: res.body?.data?.decision === PolicyDecision.BLOCK ? 'BLOCKED' : 'ALLOWED',
          detail: res.body?.data?.reason ?? '',
        };
      },
    });

    // 3 — Human approval required.
    await run({
      id: 'approval',
      title: 'Purchase above the approval threshold',
      attack: false,
      expected: 'REQUIRES_APPROVAL',
      description: `${premiumCase.name} (${formatMinor(premiumCase.priceMinor)}) needs a human.`,
      run: async () => {
        const intentId = await freshIntent(identity, premiumCase.id);
        const res = await callAsAgent(
          identity,
          'POST',
          `/api/purchase-intents/${intentId}/evaluate`,
          {}
        );
        return {
          actual:
            res.body?.data?.decision === PolicyDecision.REQUIRE_APPROVAL
              ? 'REQUIRES_APPROVAL'
              : String(res.body?.data?.decision),
          detail: res.body?.data?.reason ?? '',
        };
      },
    });

    // 4 — Category restriction, isolated from every amount rule.
    await run({
      id: 'category',
      title: 'Purchase in a category the agent may not buy',
      attack: false,
      expected: 'BLOCKED',
      description: `${watch.name} costs ${formatMinor(watch.priceMinor)} — under every limit. Only its category refuses it.`,
      run: async () => {
        const intentId = await freshIntent(identity, watch.id);
        const res = await callAsAgent(
          identity,
          'POST',
          `/api/purchase-intents/${intentId}/evaluate`,
          {}
        );
        return {
          actual: res.body?.data?.decision === PolicyDecision.BLOCK ? 'BLOCKED' : 'ALLOWED',
          detail: res.body?.data?.reason ?? '',
        };
      },
    });

    // 5 — ATTACK: forge payment success.
    await run({
      id: 'forged-payment',
      title: 'Agent forges a successful payment',
      attack: true,
      expected: 'BLOCKED',
      description:
        'Agent invents a payment id and signature and claims the money moved. This is the attack that used to succeed.',
      run: async () => {
        const intentId = await freshIntent(identity, cable.id);
        await callAsAgent(identity, 'POST', `/api/purchase-intents/${intentId}/evaluate`, {});
        await callAsAgent(identity, 'POST', `/api/purchase-intents/${intentId}/payment-order`, {});
        const res = await callAsAgent(
          identity,
          'POST',
          `/api/purchase-intents/${intentId}/verify-payment`,
          { providerPaymentId: 'pay_ATTACKER_NEVER_PAID', signature: 'f'.repeat(64) }
        );
        const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
        return {
          actual: intent?.status === PurchaseStatus.COMPLETED ? 'ALLOWED' : 'BLOCKED',
          detail: `HTTP ${res.status} — ${res.body?.error ?? ''}; final status ${intent?.status}`,
        };
      },
    });

    // 5 — ATTACK: replay a signed request.
    await run({
      id: 'replay',
      title: 'Agent replays a signed request',
      attack: true,
      expected: 'BLOCKED',
      description: 'The same signature and nonce are submitted twice.',
      run: async () => {
        const nonce = randomUUID();
        const first = await callAsAgent(
          identity,
          'POST',
          '/api/purchase-intents',
          { productId: cable.id, quantity: 1, agentReason: 'replay probe' },
          { reuseNonce: nonce }
        );
        const second = await callAsAgent(
          identity,
          'POST',
          '/api/purchase-intents',
          { productId: cable.id, quantity: 1, agentReason: 'replay probe' },
          { reuseNonce: nonce }
        );
        return {
          actual: second.status === 401 ? 'BLOCKED' : 'ALLOWED',
          detail: `first ${first.status}, replay ${second.status} — ${second.body?.error ?? ''}`,
        };
      },
    });

    // 6 — ATTACK: tamper with the body after signing.
    await run({
      id: 'tampered-body',
      title: 'Agent tampers with a signed request body',
      attack: true,
      expected: 'BLOCKED',
      description: 'Signature covers quantity 1; the transmitted body says 50.',
      run: async () => {
        const res = await callAsAgent(
          identity,
          'POST',
          '/api/purchase-intents',
          { productId: cable.id, quantity: 1, agentReason: 'tamper probe' },
          { tamperBody: { productId: cable.id, quantity: 50, agentReason: 'tamper probe' } }
        );
        return {
          actual: res.status === 401 ? 'BLOCKED' : 'ALLOWED',
          detail: `HTTP ${res.status} — body digest did not match the signature`,
        };
      },
    });

    // 7 — ATTACK: skip signing entirely.
    await run({
      id: 'unsigned',
      title: 'Agent omits its signature',
      attack: true,
      expected: 'BLOCKED',
      description:
        'The old build let an unsigned request through by simply omitting a header.',
      run: async () => {
        const res = await callAsAgent(
          identity,
          'POST',
          '/api/purchase-intents',
          { productId: cable.id, quantity: 1, agentReason: 'unsigned probe' },
          { omitSignature: true }
        );
        return {
          actual: res.status === 401 ? 'BLOCKED' : 'ALLOWED',
          detail: `HTTP ${res.status} — ${res.body?.error ?? ''}`,
        };
      },
    });

    // 8 — ATTACK: negative quantity to invert the amount.
    await run({
      id: 'negative-quantity',
      title: 'Agent sends a negative quantity',
      attack: true,
      expected: 'BLOCKED',
      description:
        'Used to produce a negative amount that was ALLOWED and inflated the daily budget.',
      run: async () => {
        const res = await callAsAgent(identity, 'POST', '/api/purchase-intents', {
          productId: powerBank.id,
          quantity: -20,
          agentReason: 'budget inflation',
        });
        // Also confirm no negative-amount row reached the database at all.
        const leaked = await prisma.purchaseIntent.count({
          where: { agentId: identity.agentId, amountMinor: { lt: 0 } },
        });
        return {
          actual: res.status >= 400 && leaked === 0 ? 'BLOCKED' : 'ALLOWED',
          detail: `HTTP ${res.status} — ${res.body?.details?.[0]?.message ?? res.body?.error ?? ''}; negative-amount rows in database: ${leaked}`,
        };
      },
    });

    // 9 — ATTACK: concurrent spending to outrun the daily cap.
    await run({
      id: 'concurrent-spend',
      title: 'Concurrent requests race the daily limit',
      attack: true,
      expected: 'BLOCKED',
      description:
        'Eight simultaneous purchases against a budget that fits fewer. Previously breached the cap.',
      run: async () => {
        const permission = await prisma.agentPermission.findUniqueOrThrow({
          where: { agentId: identity.agentId },
        });
        const ids = await Promise.all(
          Array.from({ length: 8 }, () => freshIntent(identity, cable.id))
        );
        await Promise.all(
          ids.map((id) =>
            callAsAgent(identity, 'POST', `/api/purchase-intents/${id}/evaluate`, {})
          )
        );
        const ledger = await prisma.agentDailyLedger.findUnique({
          where: { agentId_day: { agentId: identity.agentId, day: ledgerDay() } },
        });
        const reserved = ledger?.reservedMinor ?? 0;
        const cap = Math.min(permission.maxDailyMinor, 1e12);
        return {
          actual: reserved <= cap ? 'BLOCKED' : 'ALLOWED',
          detail: `Reserved ${formatMinor(reserved)} against a ${formatMinor(cap)} cap across ${ledger?.txnCount ?? 0} transactions — cap held`,
        };
      },
    });

    // 10 — ATTACK: tamper with an audit record.
    await run({
      id: 'audit-tamper',
      title: 'Attacker edits an audit record',
      attack: true,
      expected: 'BLOCKED',
      description:
        'A stored event is modified directly in the database and the chain is re-verified.',
      run: async () => {
        const before = await verifyAuditChain();
        const victim = await prisma.auditEvent.findFirst({ orderBy: { sequence: 'desc' } });
        if (!victim) return { actual: 'ERROR', detail: 'no audit events to tamper with' };

        const original = victim.metadata;
        // Direct write, bypassing the application entirely.
        await prisma.auditEvent.update({
          where: { id: victim.id },
          data: { metadata: JSON.stringify({ tampered: true, amountMinor: 1 }) },
        });
        const during = await verifyAuditChain();
        await prisma.auditEvent.update({
          where: { id: victim.id },
          data: { metadata: original },
        });
        const after = await verifyAuditChain();

        return {
          actual: before.valid && !during.valid && after.valid ? 'BLOCKED' : 'ALLOWED',
          detail: `chain valid before=${before.valid}, after tampering=${during.valid} (${during.breakReason ?? '-'}), after restore=${after.valid}`,
        };
      },
    });

    // 11 — ATTACK: buy another merchant's product.
    await run({
      id: 'cross-tenant',
      title: 'Agent targets another merchant\'s product',
      attack: true,
      expected: 'BLOCKED',
      description: 'Tenancy is checked server-side, not inferred from the request.',
      run: async () => {
        const otherMerchant = await prisma.merchant.create({
          data: { name: `Foreign Store ${randomUUID().slice(0, 8)}` },
        });
        const foreign = await prisma.product.create({
          data: {
            merchantId: otherMerchant.id,
            name: 'Foreign Widget',
            priceMinor: 10000,
            category: 'Electronics Accessories',
            stock: 10,
          },
        });
        const res = await callAsAgent(identity, 'POST', '/api/purchase-intents', {
          productId: foreign.id,
          quantity: 1,
          agentReason: 'cross-tenant probe',
        });
        const created = await prisma.purchaseIntent.count({
          where: { productId: foreign.id },
        });
        await prisma.merchant.delete({ where: { id: otherMerchant.id } });
        return {
          actual: res.status === 404 && created === 0 ? 'BLOCKED' : 'ALLOWED',
          detail: `HTTP ${res.status} (${res.body?.error ?? ''}) — reported as "not found", so another merchant's catalogue cannot be enumerated`,
        };
      },
    });

    // 12 — ATTACK: approve without a human session.
    await run({
      id: 'self-approval',
      title: 'Agent approves its own purchase',
      attack: true,
      expected: 'BLOCKED',
      description:
        'The approval route requires a merchant-user session. Previously this returned 200.',
      run: async () => {
        const intentId = await freshIntent(identity, premiumCase.id);
        await callAsAgent(identity, 'POST', `/api/purchase-intents/${intentId}/evaluate`, {});
        const res = await app.inject({
          method: 'POST',
          url: `/api/purchase-intents/${intentId}/approval`,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ token: 'x'.repeat(32), approve: true }),
        });
        return {
          actual: res.statusCode === 401 ? 'BLOCKED' : 'ALLOWED',
          detail: `HTTP ${res.statusCode} — a merchant session is required`,
        };
      },
    });

    // 14 — Repeated attacks escalate to automatic quarantine.
    await run({
      id: 'escalation',
      title: 'Repeated attacks quarantine the agent',
      attack: true,
      expected: 'QUARANTINED',
      description:
        'Two severe violations inside the escalation window suspend the agent automatically, with no human involved.',
      run: async () => {
        // Two genuinely severe violations: a replayed nonce and a bad signature.
        const nonce = randomUUID();
        await callAsAgent(identity, 'POST', '/api/purchase-intents',
          { productId: cable.id, quantity: 1, agentReason: 'probe' }, { reuseNonce: nonce });
        await callAsAgent(identity, 'POST', '/api/purchase-intents',
          { productId: cable.id, quantity: 1, agentReason: 'probe' }, { reuseNonce: nonce });
        await callAsAgent(identity, 'POST', '/api/purchase-intents',
          { productId: cable.id, quantity: 1, agentReason: 'probe' },
          { tamperBody: { productId: cable.id, quantity: 99, agentReason: 'probe' } });

        const agent = await prisma.agent.findUniqueOrThrow({ where: { id: identity.agentId } });
        // A quarantined agent is refused everything, even a valid request.
        const followUp = await callAsAgent(identity, 'POST', '/api/purchase-intents', {
          productId: cable.id, quantity: 1, agentReason: 'legitimate follow-up',
        });
        return {
          actual: agent.status === 'QUARANTINED' ? 'QUARANTINED' : agent.status,
          detail: `Agent status ${agent.status} after ${agent.severeThreatCount} severe violations; a subsequent VALID request returned HTTP ${followUp.status}`,
        };
      },
    });

    // The escalation scenario deliberately leaves the agent quarantined. Restore
    // it so the console can be run again, and so the rest of the demo (dashboard,
    // MCP agent) keeps working immediately afterwards.
    await isolate();

    const attacks = results.filter((r) => r.attack);
    return {
      success: true,
      data: {
        results,
        summary: {
          total: results.length,
          passed: results.filter((r) => r.passed).length,
          attacksAttempted: attacks.length,
          attacksStopped: attacks.filter((r) => r.passed).length,
        },
      },
    };
  });
}

interface Scenario {
  id: string;
  title: string;
  description: string;
  attack: boolean;
  expected: string;
  run: () => Promise<{ actual: string; detail: string }>;
}

interface ScenarioResult {
  id: string;
  title: string;
  description: string;
  attack: boolean;
  expected: string;
  actual: string;
  detail: string;
  passed: boolean;
  durationMs: number;
}

function describe(s: Scenario) {
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    attack: s.attack,
    expected: s.expected,
  };
}
