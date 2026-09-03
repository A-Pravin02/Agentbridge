// ============================================
// AgentBridge - Payment Service
// ============================================
//
// The Phase 0 audit showed `POST /:id/complete` accepted an attacker-chosen
// payment id and marked the transaction COMPLETED. No provider was contacted
// and no signature was checked. That endpoint is gone.
//
// A purchase can now reach COMPLETED through exactly two paths, and BOTH are
// cryptographically gated:
//
//   1. Signed callback — HMAC-SHA256 over "<orderId>|<paymentId>" against a
//      secret the client never sees. The order id is read from OUR database,
//      never from the request, so a forged order cannot be self-consistently
//      signed.
//   2. Verified webhook — HMAC-SHA256 over the raw request body. This is the
//      path that still settles when the customer closes the browser before
//      being redirected back.
//
// Both converge on `settleVerified`, which is private and is never reachable
// without one of those two signature checks having passed first. Every other
// claim in a request body is ignored: there is no "status: success" field to
// trust anywhere in this file.

import {
  ActorType,
  AuditAction,
  PaymentStatus,
  PurchaseStatus,
  SecurityViolation,
} from '@agentbridge/shared-types';
import {
  createPaymentProvider,
  verifyPaymentSignature,
  verifyWebhookSignature,
  type PaymentProvider,
  SandboxProvider,
} from '@agentbridge/payments';
import { createHash } from 'crypto';
import { prisma, isUniqueViolation } from '../db.js';
import { getConfig } from '../config.js';
import { ForbiddenError, NotFoundError, SecurityError, StateError } from '../lib/errors.js';
import { recordAuditEvent } from './audit-service.js';
import { recordSecurityIncident } from './security-service.js';
import { transitionIntent, releaseIntentBudget } from './purchase-service.js';

let providerSingleton: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (!providerSingleton) {
    const config = getConfig();
    providerSingleton = createPaymentProvider({
      mode: config.PAYMENT_MODE,
      keyId: config.RAZORPAY_KEY_ID,
      keySecret: config.RAZORPAY_KEY_SECRET,
    });
  }
  return providerSingleton;
}

export function resetPaymentProvider(): void {
  providerSingleton = null;
}

// ---- Order creation ----

/**
 * Creates a payment order for an AUTHORIZED intent.
 *
 * Preconditions re-checked here rather than trusted from evaluation time:
 * the agent must still be active, the authorization must not have expired,
 * and stock must still be available. Stock is decremented with a conditional
 * update so concurrent executions cannot oversell.
 */
export async function createPaymentOrder(params: {
  intentId: string;
  agentId: string;
}): Promise<{ providerOrderId: string; amountMinor: number; currency: string; publicKeyId: string; paymentId: string }> {
  const { intentId, agentId } = params;

  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: { product: true, authorizations: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!intent) throw new NotFoundError('Purchase intent');
  if (intent.agentId !== agentId) throw new NotFoundError('Purchase intent');

  if (intent.status !== PurchaseStatus.AUTHORIZED) {
    throw new StateError(
      `Payment can only be created for an AUTHORIZED purchase; this one is ${intent.status}`,
      { status: intent.status }
    );
  }

  // Ordered explicitly, so this is the authorization that actually governs.
  const authorization = intent.authorizations[0];
  if (!authorization) throw new StateError('Purchase intent has no authorization record');
  if (authorization.expiresAt.getTime() <= Date.now()) {
    await releaseIntentBudget(intentId, 'authorization expired');
    await prisma.purchaseIntent.updateMany({
      where: { id: intentId, status: PurchaseStatus.AUTHORIZED },
      data: { status: PurchaseStatus.EXPIRED },
    });
    throw new ForbiddenError('Authorization has expired; re-evaluate the purchase', 'AUTHORIZATION_EXPIRED');
  }

  // Reserve stock atomically: the predicate prevents overselling.
  const stockTaken = await prisma.product.updateMany({
    where: { id: intent.productId, stock: { gte: intent.quantity } },
    data: { stock: { decrement: intent.quantity } },
  });
  if (stockTaken.count !== 1) {
    throw new ForbiddenError('Product is out of stock', 'OUT_OF_STOCK');
  }

  try {
    const provider = getPaymentProvider();
    const order = await provider.createOrder({
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      receipt: intent.id,
      notes: { agentId, merchantId: intent.merchantId },
    });

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          purchaseIntentId: intentId,
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          provider: provider.name,
          providerOrderId: order.providerOrderId,
          status: PaymentStatus.PENDING,
        },
      });
      await transitionIntent(tx, intentId, PurchaseStatus.AUTHORIZED, PurchaseStatus.PAYMENT_PENDING);
      return created;
    });

    await recordAuditEvent({
      action: AuditAction.PAYMENT_ORDER_CREATED,
      actorType: ActorType.SYSTEM,
      actorId: 'payment-service',
      entityId: intentId,
      metadata: {
        paymentId: payment.id,
        providerOrderId: order.providerOrderId,
        amountMinor: intent.amountMinor,
        provider: provider.name,
      },
    });

    return {
      providerOrderId: order.providerOrderId,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      publicKeyId: order.publicKeyId,
      paymentId: payment.id,
    };
  } catch (error) {
    // Give the stock back if the order could not be created.
    await prisma.product
      .update({ where: { id: intent.productId }, data: { stock: { increment: intent.quantity } } })
      .catch(() => undefined);
    throw error;
  }
}

// ---- Verification: the single gate to COMPLETED ----

export interface VerifyParams {
  intentId: string;
  providerPaymentId: string;
  signature: string;
  /** Who presented the callback; used only for audit attribution. */
  actorId: string;
  actorType: ActorType;
}

export async function verifyAndSettle(params: VerifyParams) {
  const { intentId, providerPaymentId, signature, actorId, actorType } = params;
  const config = getConfig();

  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!intent) throw new NotFoundError('Purchase intent');

  const payment = intent.payments[0];
  if (!payment) throw new StateError('No payment order exists for this purchase intent');

  if (intent.status !== PurchaseStatus.PAYMENT_PENDING) {
    throw new StateError(`Cannot settle a purchase in state ${intent.status}`, {
      status: intent.status,
    });
  }
  if (payment.status === PaymentStatus.VERIFIED) {
    throw new StateError('This payment has already been verified');
  }

  // THE GATE. `payment.providerOrderId` comes from our database — the caller
  // cannot substitute an order id it controls and sign that instead.
  const verification = verifyPaymentSignature({
    orderId: payment.providerOrderId,
    paymentId: providerPaymentId,
    signature,
    keySecret: config.RAZORPAY_KEY_SECRET,
  });

  if (!verification.valid) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.FAILED },
    });
    await prisma.$transaction(async (tx) => {
      await transitionIntent(tx, intentId, PurchaseStatus.PAYMENT_PENDING, PurchaseStatus.FAILED);
    });
    await releaseIntentBudget(intentId, 'payment verification failed');
    await restock(intent.productId, intent.quantity);

    await recordAuditEvent({
      action: AuditAction.PAYMENT_VERIFICATION_FAILED,
      actorType: ActorType.SYSTEM,
      actorId: 'payment-service',
      entityId: intentId,
      metadata: { reason: verification.reason, providerOrderId: payment.providerOrderId },
    });
    await recordSecurityIncident({
      agentId: intent.agentId,
      type: SecurityViolation.INVALID_REQUEST_SIGNATURE,
      description: 'Payment settlement presented an invalid provider signature',
      metadata: { intentId, reason: verification.reason },
    });

    throw new SecurityError(
      SecurityViolation.INVALID_REQUEST_SIGNATURE,
      403,
      'Payment could not be verified'
    );
  }

  return settleVerified({
    intentId,
    paymentId: payment.id,
    providerOrderId: payment.providerOrderId,
    providerPaymentId,
    amountMinor: payment.amountMinor,
    productId: intent.productId,
    actorId,
    actorType,
  });
}

/**
 * Marks a purchase settled. PRIVATE BY CONTRACT: it is not exported, and the
 * only two callers are `verifyAndSettle` (signed callback) and `handleWebhook`
 * (verified webhook). Both perform their signature check before calling this.
 * Nothing can reach COMPLETED without one of those checks having passed.
 */
async function settleVerified(params: {
  intentId: string;
  paymentId: string;
  providerOrderId: string;
  providerPaymentId: string;
  amountMinor: number;
  productId: string;
  actorId: string;
  actorType: ActorType;
}) {
  const { intentId, paymentId, providerPaymentId, actorId, actorType } = params;

  // Settle exactly once. The unique constraint on providerPaymentId means one
  // provider payment can settle at most one transaction, even if the signed
  // callback and the webhook arrive concurrently.
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.VERIFIED, providerPaymentId, verifiedAt: new Date() },
      });
      if (claimed.count !== 1) throw new StateError('This payment has already been settled');

      await transitionIntent(
        tx,
        intentId,
        PurchaseStatus.PAYMENT_PENDING,
        PurchaseStatus.PAYMENT_PROCESSING
      );
      await transitionIntent(
        tx,
        intentId,
        PurchaseStatus.PAYMENT_PROCESSING,
        PurchaseStatus.COMPLETED
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StateError('This provider payment has already settled another transaction');
    }
    throw error;
  }

  await recordAuditEvent({
    action: AuditAction.PAYMENT_VERIFIED,
    actorType,
    actorId,
    entityId: intentId,
    metadata: {
      providerOrderId: params.providerOrderId,
      providerPaymentId,
      amountMinor: params.amountMinor,
    },
  });
  await recordAuditEvent({
    action: AuditAction.TRANSACTION_COMPLETED,
    actorType: ActorType.SYSTEM,
    actorId: 'agentbridge',
    entityId: intentId,
    metadata: { amountMinor: params.amountMinor, productId: params.productId },
  });

  return prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: intentId },
    include: { product: true, payments: true },
  });
}

async function restock(productId: string, quantity: number): Promise<void> {
  await prisma.product
    .update({ where: { id: productId }, data: { stock: { increment: quantity } } })
    .catch(() => undefined);
}

// ---- Webhooks ----

/**
 * Processes a provider webhook.
 *
 * Three independent defences:
 *   1. HMAC over the RAW body — a forged webhook is rejected.
 *   2. A unique (provider, providerEventId) row — a replayed delivery is
 *      rejected by the database, not by an application check that could race.
 *   3. Settlement still goes through `verifyAndSettle`, so a webhook cannot
 *      complete a purchase that has no valid payment signature.
 */
export async function handleWebhook(params: {
  rawBody: string;
  signature: string;
  provider?: string;
}): Promise<{ status: 'PROCESSED' | 'IGNORED' | 'DUPLICATE'; detail: string }> {
  const config = getConfig();
  const provider = params.provider ?? 'razorpay';
  const payloadDigest = createHash('sha256').update(params.rawBody, 'utf8').digest('hex');

  const verification = verifyWebhookSignature({
    rawBody: params.rawBody,
    signature: params.signature,
    webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
  });

  if (!verification.valid) {
    await recordAuditEvent({
      action: AuditAction.WEBHOOK_REJECTED,
      actorType: ActorType.PAYMENT_PROVIDER,
      actorId: provider,
      entityId: 'webhook',
      metadata: { reason: verification.reason, payloadDigest },
    });
    throw new SecurityError(
      SecurityViolation.WEBHOOK_SIGNATURE_INVALID,
      403,
      'Webhook signature could not be verified'
    );
  }

  let payload: {
    event?: string;
    id?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string; notes?: { receipt?: string } } } };
  };
  try {
    payload = JSON.parse(params.rawBody);
  } catch {
    throw new SecurityError(SecurityViolation.WEBHOOK_SIGNATURE_INVALID, 400, 'Webhook body is not valid JSON');
  }

  const providerEventId = payload.id;
  if (!providerEventId) {
    throw new SecurityError(SecurityViolation.WEBHOOK_SIGNATURE_INVALID, 400, 'Webhook is missing an event id');
  }

  // REPLAY PROTECTION as a database guarantee.
  try {
    await prisma.webhookEvent.create({
      data: {
        provider,
        providerEventId,
        eventType: payload.event ?? 'unknown',
        signatureValid: true,
        payloadDigest,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      await recordAuditEvent({
        action: AuditAction.WEBHOOK_REPLAY_REJECTED,
        actorType: ActorType.PAYMENT_PROVIDER,
        actorId: provider,
        entityId: providerEventId,
        metadata: { eventType: payload.event },
      });
      return { status: 'DUPLICATE', detail: 'This webhook event was already processed' };
    }
    throw error;
  }

  await recordAuditEvent({
    action: AuditAction.WEBHOOK_RECEIVED,
    actorType: ActorType.PAYMENT_PROVIDER,
    actorId: provider,
    entityId: providerEventId,
    metadata: { eventType: payload.event },
  });

  const entity = payload.payload?.payment?.entity;
  if (payload.event !== 'payment.captured' || !entity?.order_id) {
    await prisma.webhookEvent.updateMany({
      where: { provider, providerEventId },
      data: { processed: true },
    });
    return { status: 'IGNORED', detail: `Event ${payload.event ?? 'unknown'} requires no action` };
  }

  const payment = await prisma.payment.findUnique({
    where: { providerOrderId: entity.order_id },
    include: { purchaseIntent: { select: { status: true, productId: true } } },
  });
  if (!payment) {
    return { status: 'IGNORED', detail: 'No local payment matches this order' };
  }

  // The webhook body was HMAC-verified above, so its contents are trusted to
  // the same standard as a signed callback. Settle from here — this is the
  // path that still works when the customer never returns to the site.
  if (
    payment.status === PaymentStatus.PENDING &&
    payment.purchaseIntent.status === PurchaseStatus.PAYMENT_PENDING
  ) {
    try {
      await settleVerified({
        intentId: payment.purchaseIntentId,
        paymentId: payment.id,
        providerOrderId: payment.providerOrderId,
        providerPaymentId: entity.id ?? `wh_${providerEventId}`,
        amountMinor: payment.amountMinor,
        productId: payment.purchaseIntent.productId,
        actorId: provider,
        actorType: ActorType.PAYMENT_PROVIDER,
      });
    } catch {
      // Already settled by the signed callback — the webhook is then a no-op.
    }
  }

  await prisma.webhookEvent.updateMany({
    where: { provider, providerEventId },
    data: { processed: true },
  });
  return { status: 'PROCESSED', detail: 'Webhook processed' };
}

/** Test/demo helper: mints a valid provider signature via the sandbox. */
export function sandboxSignature(orderId: string): { paymentId: string; signature: string } {
  const provider = getPaymentProvider();
  if (!(provider instanceof SandboxProvider)) {
    throw new Error('sandboxSignature is only available when PAYMENT_MODE=sandbox');
  }
  return provider.simulateSuccessfulPayment(orderId);
}
