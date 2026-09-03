// ============================================
// Payment signatures — the gate between "claims paid" and "is paid"
// ============================================

import { describe, it, expect } from 'vitest';
import {
  signPayment,
  signWebhook,
  verifyPaymentSignature,
  verifyWebhookSignature,
  safeCompareHex,
  SandboxProvider,
} from '../src/index.js';

const SECRET = 'test_key_secret_0123456789abcdef';
const ORDER = 'order_test_abc123';
const PAYMENT = 'pay_test_xyz789';

describe('verifyPaymentSignature', () => {
  it('accepts a signature the provider actually minted', () => {
    const signature = signPayment(ORDER, PAYMENT, SECRET);
    expect(verifyPaymentSignature({ orderId: ORDER, paymentId: PAYMENT, signature, keySecret: SECRET }).valid).toBe(true);
  });

  it('rejects an invented signature — the "fake payment success" attack', () => {
    const result = verifyPaymentSignature({
      orderId: ORDER,
      paymentId: 'pay_ATTACKER_NEVER_PAID',
      signature: 'f'.repeat(64),
      keySecret: SECRET,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a signature minted for a DIFFERENT order', () => {
    // Stops an attacker replaying a real signature from their own cheap order
    // onto someone else's expensive one.
    const signature = signPayment('order_other', PAYMENT, SECRET);
    expect(verifyPaymentSignature({ orderId: ORDER, paymentId: PAYMENT, signature, keySecret: SECRET }).valid).toBe(false);
  });

  it('rejects a signature minted for a different payment id', () => {
    const signature = signPayment(ORDER, 'pay_other', SECRET);
    expect(verifyPaymentSignature({ orderId: ORDER, paymentId: PAYMENT, signature, keySecret: SECRET }).valid).toBe(false);
  });

  it('rejects a signature minted with the wrong secret', () => {
    const signature = signPayment(ORDER, PAYMENT, 'attacker_guess');
    expect(verifyPaymentSignature({ orderId: ORDER, paymentId: PAYMENT, signature, keySecret: SECRET }).valid).toBe(false);
  });

  it('FAILS CLOSED when no secret is configured', () => {
    // An unconfigured deployment must reject everything, never accept everything.
    const result = verifyPaymentSignature({ orderId: ORDER, paymentId: PAYMENT, signature: 'anything', keySecret: '' });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });

  it('rejects missing or malformed input without throwing', () => {
    for (const signature of ['', 'not-hex-at-all', 'ab', 'z'.repeat(64)]) {
      expect(verifyPaymentSignature({ orderId: ORDER, paymentId: PAYMENT, signature, keySecret: SECRET }).valid).toBe(false);
    }
    expect(verifyPaymentSignature({ orderId: '', paymentId: PAYMENT, signature: 'a'.repeat(64), keySecret: SECRET }).valid).toBe(false);
  });
});

describe('verifyWebhookSignature', () => {
  const BODY = JSON.stringify({ event: 'payment.captured', id: 'evt_1' });

  it('accepts a correctly signed body', () => {
    expect(verifyWebhookSignature({ rawBody: BODY, signature: signWebhook(BODY, SECRET), webhookSecret: SECRET }).valid).toBe(true);
  });

  it('rejects a forged webhook', () => {
    expect(verifyWebhookSignature({ rawBody: BODY, signature: 'a'.repeat(64), webhookSecret: SECRET }).valid).toBe(false);
  });

  it('rejects when the body is altered after signing', () => {
    const signature = signWebhook(BODY, SECRET);
    const tampered = JSON.stringify({ event: 'payment.captured', id: 'evt_1', extra: true });
    expect(verifyWebhookSignature({ rawBody: tampered, signature, webhookSecret: SECRET }).valid).toBe(false);
  });

  it('is sensitive to whitespace — proving it verifies RAW bytes', () => {
    // This is why the server captures the raw buffer instead of re-serializing.
    const signature = signWebhook(BODY, SECRET);
    const reserialized = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifyWebhookSignature({ rawBody: reserialized, signature, webhookSecret: SECRET }).valid).toBe(false);
  });

  it('fails closed with no secret', () => {
    expect(verifyWebhookSignature({ rawBody: BODY, signature: 'x', webhookSecret: '' }).valid).toBe(false);
  });
});

describe('safeCompareHex', () => {
  it('matches identical digests', () => {
    expect(safeCompareHex('abcd1234', 'abcd1234')).toBe(true);
  });
  it('rejects differing digests, wrong lengths and non-strings', () => {
    expect(safeCompareHex('abcd1234', 'abcd1235')).toBe(false);
    expect(safeCompareHex('abcd', 'abcd1234')).toBe(false);
    expect(safeCompareHex('abcd', undefined as unknown as string)).toBe(false);
  });
});

describe('SandboxProvider', () => {
  it('mints signatures its own verifier accepts', async () => {
    const provider = new SandboxProvider('rzp_test_key', SECRET);
    const order = await provider.createOrder({ amountMinor: 29900, currency: 'INR', receipt: 'intent_1' });
    const { paymentId, signature } = provider.simulateSuccessfulPayment(order.providerOrderId);

    expect(
      verifyPaymentSignature({
        orderId: order.providerOrderId,
        paymentId,
        signature,
        keySecret: SECRET,
      }).valid
    ).toBe(true);
  });

  it('issues unique order ids', async () => {
    const provider = new SandboxProvider('rzp_test_key', SECRET);
    const ids = await Promise.all(
      Array.from({ length: 50 }, () =>
        provider.createOrder({ amountMinor: 100, currency: 'INR', receipt: 'r' })
      )
    );
    expect(new Set(ids.map((o) => o.providerOrderId)).size).toBe(50);
  });

  it('preserves the amount in minor units', async () => {
    const provider = new SandboxProvider('rzp_test_key', SECRET);
    const order = await provider.createOrder({ amountMinor: 149900, currency: 'INR', receipt: 'r' });
    expect(order.amountMinor).toBe(149900);
  });
});
