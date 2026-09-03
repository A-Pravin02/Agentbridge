// ============================================
// AgentBridge - Payment Provider
// ============================================
//
// Two implementations behind one interface:
//
//   RazorpayProvider  — talks to Razorpay's real test-mode API.
//   SandboxProvider   — creates orders locally, no network.
//
// HONEST SCOPE NOTE: the sandbox simulates the COUNTERPARTY, not the
// verification. Signature checking is `verifyPaymentSignature` in both cases —
// the same HMAC, the same timing-safe comparison, the same fail-closed
// behaviour. Switching to real Razorpay keys changes which server mints the
// signature and changes nothing about how the server checks it.
//
// The sandbox holds the key secret, so it can mint a VALID signature (the happy
// path) and callers can also mint deliberately INVALID ones (the attack path).
// That is what makes "fake payment success" a demonstrable, failing attack
// rather than an untested claim.

import type { Minor } from '@agentbridge/shared-types';
import { signPayment } from './signature.js';

export interface PaymentOrder {
  providerOrderId: string;
  amountMinor: Minor;
  currency: string;
  /** Public key id the client would use; never the secret. */
  publicKeyId: string;
}

export interface CreateOrderParams {
  amountMinor: Minor;
  currency: string;
  /** Our own purchase-intent id, echoed back by the provider for correlation. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface PaymentProvider {
  readonly name: string;
  createOrder(params: CreateOrderParams): Promise<PaymentOrder>;
}

export class PaymentProviderError extends Error {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'PaymentProviderError';
    this.statusCode = statusCode;
  }
}

// ---- Real Razorpay (test mode) ----

export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly baseUrl: string;

  constructor(keyId: string, keySecret: string, baseUrl = 'https://api.razorpay.com/v1') {
    if (!keyId || !keySecret) {
      throw new PaymentProviderError('Razorpay requires both a key id and a key secret');
    }
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.baseUrl = baseUrl;
  }

  async createOrder(params: CreateOrderParams): Promise<PaymentOrder> {
    const auth = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Razorpay expects the amount in minor units — which is what we store.
        amount: params.amountMinor,
        currency: params.currency,
        receipt: params.receipt,
        notes: params.notes ?? {},
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PaymentProviderError(
        `Razorpay order creation failed with status ${res.status}: ${text.slice(0, 200)}`,
        res.status
      );
    }

    const body = (await res.json()) as { id?: string; amount?: number; currency?: string };
    if (!body.id) {
      throw new PaymentProviderError('Razorpay response did not contain an order id');
    }

    // Trust the provider's echoed amount only to cross-check our own, never to
    // replace it. A mismatch means something is badly wrong; refuse to proceed.
    if (typeof body.amount === 'number' && body.amount !== params.amountMinor) {
      throw new PaymentProviderError(
        `Razorpay echoed amount ${body.amount} but ${params.amountMinor} was requested`
      );
    }

    return {
      providerOrderId: body.id,
      amountMinor: params.amountMinor,
      currency: params.currency,
      publicKeyId: this.keyId,
    };
  }
}

// ---- Local sandbox ----

export class SandboxProvider implements PaymentProvider {
  readonly name = 'razorpay_sandbox';
  private readonly keyId: string;
  private readonly keySecret: string;
  private counter = 0;

  constructor(keyId: string, keySecret: string) {
    this.keyId = keyId;
    this.keySecret = keySecret;
  }

  async createOrder(params: CreateOrderParams): Promise<PaymentOrder> {
    this.counter += 1;
    const unique = `${Date.now().toString(36)}${this.counter.toString(36)}`;
    return {
      providerOrderId: `order_sbx_${unique}`,
      amountMinor: params.amountMinor,
      currency: params.currency,
      publicKeyId: this.keyId,
    };
  }

  /**
   * Simulates the customer completing payment: returns the payment id and the
   * signature the provider would have produced. Used by the demo's happy path
   * and by tests. Attack scenarios simply pass a signature this did not mint.
   */
  simulateSuccessfulPayment(orderId: string): { paymentId: string; signature: string } {
    this.counter += 1;
    const paymentId = `pay_sbx_${Date.now().toString(36)}${this.counter.toString(36)}`;
    return {
      paymentId,
      signature: signPayment(orderId, paymentId, this.keySecret),
    };
  }
}

export function createPaymentProvider(config: {
  mode: 'razorpay' | 'sandbox';
  keyId: string;
  keySecret: string;
}): PaymentProvider {
  return config.mode === 'razorpay'
    ? new RazorpayProvider(config.keyId, config.keySecret)
    : new SandboxProvider(config.keyId, config.keySecret);
}
