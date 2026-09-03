// ============================================
// AgentBridge - Payment Signature Verification
// ============================================
//
// This file implements Razorpay's ACTUAL signature algorithms. It is the code
// that decides whether money moved, and it is identical whether the counterparty
// is Razorpay's live test API or the local sandbox provider.
//
//   Payment:  HMAC_SHA256( "<order_id>|<payment_id>", key_secret )
//   Webhook:  HMAC_SHA256( "<raw request body>",      webhook_secret )
//
// Both comparisons are timing-safe. Nothing here trusts a client-reported
// status field: a payment is verified if and only if the HMAC matches.

import { createHmac, timingSafeEqual } from 'crypto';

export interface SignatureVerification {
  valid: boolean;
  reason?: string;
}

/**
 * Constant-time comparison of two hex digests.
 * Returns false rather than throwing on malformed input, so an attacker cannot
 * distinguish "bad hex" from "wrong signature" by observing an error type.
 */
export function safeCompareHex(expectedHex: string, actualHex: string): boolean {
  if (typeof actualHex !== 'string' || actualHex.length !== expectedHex.length) {
    return false;
  }
  try {
    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(actualHex, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Produces the signature a payment provider would return for an order+payment pair. */
export function signPayment(orderId: string, paymentId: string, keySecret: string): string {
  return createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
}

/**
 * Verifies a payment callback signature.
 *
 * This is the single gate between "an agent claims it paid" and "the server
 * believes money moved". It is called only with a server-loaded `keySecret`
 * and with an `orderId` read from the server's own database — never from the
 * request body — so a forged order id cannot be self-consistently signed.
 */
export function verifyPaymentSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
  keySecret: string;
}): SignatureVerification {
  const { orderId, paymentId, signature, keySecret } = params;

  if (!orderId || !paymentId) {
    return { valid: false, reason: 'Missing order or payment identifier' };
  }
  if (!signature) {
    return { valid: false, reason: 'Missing payment signature' };
  }
  if (!keySecret) {
    // Fail closed: an unconfigured secret must never mean "accept everything".
    return { valid: false, reason: 'Payment provider secret is not configured' };
  }

  const expected = signPayment(orderId, paymentId, keySecret);
  return safeCompareHex(expected, signature)
    ? { valid: true }
    : { valid: false, reason: 'Payment signature does not match' };
}

/** Produces the signature a provider would send with a webhook body. */
export function signWebhook(rawBody: string, webhookSecret: string): string {
  return createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Verifies a webhook signature over the EXACT raw bytes received.
 *
 * The raw body matters: re-serializing parsed JSON changes key order and
 * whitespace, which changes the digest. The API captures the raw buffer in a
 * content-type parser specifically so this check is meaningful.
 */
export function verifyWebhookSignature(params: {
  rawBody: string;
  signature: string;
  webhookSecret: string;
}): SignatureVerification {
  const { rawBody, signature, webhookSecret } = params;

  if (!signature) return { valid: false, reason: 'Missing webhook signature header' };
  if (!webhookSecret) return { valid: false, reason: 'Webhook secret is not configured' };

  const expected = signWebhook(rawBody, webhookSecret);
  return safeCompareHex(expected, signature)
    ? { valid: true }
    : { valid: false, reason: 'Webhook signature does not match' };
}
