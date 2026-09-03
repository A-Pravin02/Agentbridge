// ============================================
// AgentBridge - Route Registration
// ============================================

import type { FastifyInstance } from 'fastify';
import { ActorType, AuditAction, formatMinor, type Currency } from '@agentbridge/shared-types';
import { prisma } from '../db.js';
import { getConfig } from '../config.js';
import { productQuerySchema } from '../schemas.js';
import { authenticateAgent } from '../plugins/auth.js';
import { purchaseIntentRoutes } from './purchase-intents.js';
import { merchantRoutes } from './merchant.js';
import { demoRoutes } from './demo.js';
import { handleWebhook } from '../services/payment-service.js';
import { recordAuditEvent } from '../services/audit-service.js';
import { NotFoundError } from '../lib/errors.js';

export async function registerRoutes(app: FastifyInstance) {
  const config = getConfig();

  // ---- Health ----

  app.get('/health', async () => ({
    status: 'ok',
    service: 'agentbridge-api',
    timestamp: new Date().toISOString(),
  }));

  /** Readiness: only ok when the database actually answers. */
  app.get('/ready', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'connected' };
    } catch {
      return reply.status(503).send({ status: 'not_ready', database: 'unreachable' });
    }
  });

  // ---- Catalog (agent-authenticated, tenant-scoped) ----

  app.register(async (catalog) => {
    catalog.addHook('preHandler', authenticateAgent);

    catalog.get('/products', async (request) => {
      const q = productQuerySchema.parse(request.query ?? {});
      const agent = request.agent!;

      const products = await prisma.product.findMany({
        where: {
          // Scoped to the agent's own merchant. No cross-tenant discovery.
          merchantId: agent.merchantId,
          active: true,
          ...(q.category ? { category: q.category } : {}),
          ...(q.maxPriceMinor !== undefined ? { priceMinor: { lte: q.maxPriceMinor } } : {}),
          ...(q.query ? { name: { contains: q.query } } : {}),
        },
        orderBy: { priceMinor: 'asc' },
        take: q.limit,
      });

      await recordAuditEvent({
        action: AuditAction.PRODUCT_SEARCHED,
        actorType: ActorType.AGENT,
        actorId: agent.id,
        entityId: agent.merchantId,
        metadata: { query: q.query, category: q.category, resultCount: products.length },
      });

      return {
        success: true,
        data: products.map(serializeProduct),
      };
    });

    catalog.get('/products/:id', async (request) => {
      const { id } = request.params as { id: string };
      const agent = request.agent!;
      const product = await prisma.product.findUnique({ where: { id } });
      // Indistinguishable from "does not exist" across tenants.
      if (!product || !product.active || product.merchantId !== agent.merchantId) {
        throw new NotFoundError('Product');
      }
      return { success: true, data: serializeProduct(product) };
    });

    /** The agent's own passport and remaining budget. Self-scoped only. */
    catalog.get('/me', async (request) => {
      const agent = request.agent!;
      const [record, permission] = await Promise.all([
        prisma.agent.findUniqueOrThrow({
          where: { id: agent.id },
          select: { id: true, name: true, status: true, merchantId: true },
        }),
        prisma.agentPermission.findUnique({ where: { agentId: agent.id } }),
      ]);
      const { getUsage } = await import('../services/ledger-service.js');
      const usage = await getUsage(agent.id);

      return {
        success: true,
        data: {
          agent: record,
          passport: permission && {
            maxTransactionMinor: permission.maxTransactionMinor,
            maxTransactionDisplay: formatMinor(permission.maxTransactionMinor),
            maxDailyMinor: permission.maxDailyMinor,
            maxDailyDisplay: formatMinor(permission.maxDailyMinor),
            allowedCategories: JSON.parse(permission.allowedCategories),
            maxTransactionsPerDay: permission.maxTransactionsPerDay,
            expiresAt: permission.expiresAt,
          },
          usageToday: {
            spentMinor: usage.reservedMinor,
            spentDisplay: formatMinor(usage.reservedMinor),
            transactionCount: usage.txnCount,
            remainingMinor: Math.max(0, (permission?.maxDailyMinor ?? 0) - usage.reservedMinor),
            remainingDisplay: formatMinor(
              Math.max(0, (permission?.maxDailyMinor ?? 0) - usage.reservedMinor)
            ),
          },
        },
      };
    });
  });

  // ---- Purchase lifecycle ----
  await app.register(purchaseIntentRoutes);

  // ---- Merchant dashboard ----
  await app.register(merchantRoutes);

  // ---- Payment webhooks ----
  // Unauthenticated by design: the HMAC over the raw body IS the authentication.
  app.post('/webhooks/razorpay', async (request, reply) => {
    const signature = request.headers['x-razorpay-signature'];
    const result = await handleWebhook({
      rawBody: (request as { rawBody?: string }).rawBody ?? '',
      signature: typeof signature === 'string' ? signature : '',
    });
    return reply.status(200).send({ success: true, data: result });
  });

  // ---- Demo (development only; refused in production by config) ----
  if (config.ENABLE_DEMO_ROUTES) {
    await app.register(demoRoutes, { prefix: '/demo' });
  }
}

function serializeProduct(p: {
  id: string;
  priceMinor: number;
  currency: string;
  [k: string]: unknown;
}) {
  return { ...p, priceDisplay: formatMinor(p.priceMinor, p.currency as Currency) };
}
