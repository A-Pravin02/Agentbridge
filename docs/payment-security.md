# Payment Security

## The rule

> Never allow: frontend → "payment successful" → database = paid.

In the previous build that exact path existed: `POST /:id/complete` accepted an
attacker-chosen payment id and marked the transaction COMPLETED, with no provider
contacted and no signature checked. That endpoint is gone.

## The two settlement paths

`COMPLETED` is reachable through exactly two routes, and both are cryptographically
gated:

```
1. Signed callback     HMAC-SHA256( "<orderId>|<paymentId>", keySecret )
2. Verified webhook    HMAC-SHA256( raw request body,        webhookSecret )
                                    |
                                    v
                            settleVerified()      <- private, not exported
```

`settleVerified` has exactly two callers, both of which perform their signature check
first. Nothing else in the codebase can reach it.

## Why the order id comes from our database

```ts
verifyPaymentSignature({
  orderId: payment.providerOrderId,   // from OUR row, never the request
  paymentId: body.providerPaymentId,
  signature: body.signature,
  keySecret: config.RAZORPAY_KEY_SECRET,
});
```

If the order id were taken from the request, an attacker could supply *both* an order
id and a matching signature for an order they control — a self-consistent forgery.
Reading it from our own database makes that impossible.

There is no `status` field anywhere in the request that the server reads.

## Webhooks

Three independent defences:

1. **HMAC over the raw bytes.** The server captures the raw body in a content-type
   parser before JSON parsing. This matters: re-serializing parsed JSON changes key
   order and whitespace, which changes the digest, which would make the check
   meaningless. There is a test asserting exactly that sensitivity.
2. **Replay rejection as a database guarantee.** `@@unique([provider, providerEventId])`
   — a duplicate delivery fails at the storage layer, not in an application check that
   could race.
3. **Settlement still goes through `settleVerified`,** with the same uniqueness
   guarantees as the callback path.

The webhook endpoint is deliberately unauthenticated: the HMAC over the body *is* the
authentication. It is also the path that still settles when a customer closes the
browser before being redirected back.

## Single settlement

`providerPaymentId` is globally unique, so one provider payment can settle at most one
transaction — even if the signed callback and the webhook arrive concurrently. The
status transition is also conditional (`where: { status: PENDING }`), so a second
attempt matches zero rows.

## Stock

Reserved with a conditional decrement before the order is created:

```ts
where: { id: productId, stock: { gte: quantity } }
```

Concurrent executions cannot oversell. If order creation then fails, the stock is
restored; if verification fails, the stock is restored and the budget released.

## Sandbox vs Razorpay, stated precisely

| | `PAYMENT_MODE=sandbox` | `PAYMENT_MODE=razorpay` |
|---|---|---|
| Order creation | Local, no network | Razorpay test-mode API |
| Signature **verification** | `verifyPaymentSignature` | **the same function** |
| Timing-safe comparison | yes | yes |
| Fail-closed with no secret | yes | yes |

The sandbox simulates the **counterparty**, never the **verification**. Switching to
real test keys changes which server mints signatures; it changes nothing about how
they are checked.

That distinction is what makes "fake payment success" a demonstrable, failing attack
in the demo rather than an untested claim — and it is also why the sandbox holds the
key secret: so it can mint a *valid* signature for the happy path while the attack
scenarios pass signatures it never minted.

## What is not stored

No card numbers, no CVVs, no UPI handles, no bank details. Only provider-issued
identifiers (`order_...`, `pay_...`), which are opaque references, plus the amount,
currency and status.
