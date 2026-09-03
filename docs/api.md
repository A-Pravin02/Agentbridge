# API Reference

Base URL: `http://localhost:3001`

Two authentication schemes, deliberately distinct — an agent can never present a
merchant session, and vice versa.

| Principal | Scheme |
|---|---|
| **Agent** | Ed25519 signature headers |
| **Merchant user** | `Authorization: Bearer <session token>` |

---

## Agent authentication

Every agent request carries four headers. All are mandatory; omitting one is a
failure, never a skipped check.

| Header | Value |
|---|---|
| `X-Agent-Key-Id` | The agent's public key id (`ak_...`) |
| `X-Request-Id` | A fresh nonce. Single-use, enforced by a unique index |
| `X-Timestamp` | Milliseconds since epoch. ±5 minutes |
| `X-Agent-Signature` | base64 Ed25519 over the canonical request |

Mutating routes additionally require `Idempotency-Key` (8–200 chars).

### The canonical request

```
AGENTBRIDGE-ED25519-V1\n
<keyId>\n
<requestId>\n
<timestamp>\n
<METHOD>\n
<path without query string>\n
<sha256hex(raw body)>
```

### Signing example

```ts
import { createHash, createPrivateKey, sign, randomUUID } from 'crypto';

const body = JSON.stringify({ productId: 'prod_x', quantity: 1, agentReason: 'user asked' });
const requestId = randomUUID();
const timestamp = String(Date.now());

const canonical = [
  'AGENTBRIDGE-ED25519-V1',
  keyId, requestId, timestamp,
  'POST', '/api/purchase-intents',
  createHash('sha256').update(body).digest('hex'),
].join('\n');

const key = createPrivateKey({
  key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8',
});
const signature = sign(null, Buffer.from(canonical), key).toString('base64');
```

---

## Response envelope

```jsonc
// success
{ "success": true, "data": { } }

// failure
{ "success": false, "error": "Human-readable message",
  "code": "STABLE_CODE", "requestId": "req_...",
  "details": [{ "path": "quantity", "message": "..." }] }   // 400 only
```

| Status | Meaning |
|---|---|
| 400 | Validation failed — the only case carrying field-level detail |
| 401 | Not authenticated. Identical response for unknown key and bad signature |
| 403 | Authenticated but not permitted. Generic message by design |
| 404 | Not found **or** not yours — deliberately indistinguishable |
| 409 | State conflict, idempotency conflict, or replayed approval |
| 429 | Rate limited |
| 500 | Unexpected. Correlation id only |

---

## Public

### `GET /api/health`
Liveness.

### `GET /api/ready`
Readiness. 503 unless the database answers.

### `POST /api/webhooks/razorpay`
Unauthenticated by design — the HMAC over the raw body *is* the authentication.
Requires `X-Razorpay-Signature`. Replays return `{ status: "DUPLICATE" }`.

---

## Agent routes

All require agent authentication and are scoped to the agent's own merchant.

### `GET /api/products`
Query: `query`, `category`, `maxPriceMinor`, `limit` (1–100, default 50).

```jsonc
{ "success": true, "data": [
  { "id": "prod_usb_cable", "name": "USB-C Cable",
    "priceMinor": 29900, "priceDisplay": "₹299.00",
    "currency": "INR", "category": "Electronics Accessories", "stock": 20 }
] }
```

### `GET /api/products/:id`
404 for another merchant's product — indistinguishable from nonexistent.

### `GET /api/me`
This agent's passport and remaining daily budget.

### `POST /api/purchase-intents`
Requires `Idempotency-Key`.

```jsonc
{ "productId": "prod_usb_cable", "quantity": 1, "agentReason": "user asked for a cable" }
```

`quantity` is an integer 1–1000. There is **no** amount field; supplying one is a 400.

### `POST /api/purchase-intents/:id/evaluate`
Runs risk analysis, the policy engine, and — on ALLOW — the atomic budget reservation.

```jsonc
{ "success": true, "data": {
  "decision": "BLOCK",
  "reasonCode": "TRANSACTION_LIMIT_EXCEEDED",
  "reason": "Transaction amount ₹1,499.00 exceeds the per-transaction limit of ₹500.00",
  "policyVersion": 1,
  "decisionId": "uuid",
  "evaluatedRules": [ /* all 15 */ ],
  "risk": { "score": 0, "level": "LOW", "factors": [] },
  "agentQuarantined": false,
  "approval": { "token": "...", "expiresAt": "..." }   // only on REQUIRE_APPROVAL
} }
```

The `approval.token` is returned exactly once, only to the owning agent. The MCP
server strips it before anything reaches the model.

### `POST /api/purchase-intents/:id/payment-order`
Requires status `AUTHORIZED` and an unexpired authorization. Reserves stock.

```jsonc
{ "success": true, "data": {
  "providerOrderId": "order_...", "amountMinor": 29900,
  "currency": "INR", "publicKeyId": "rzp_test_...", "paymentId": "..." } }
```

### `POST /api/purchase-intents/:id/verify-payment`

```jsonc
{ "providerPaymentId": "pay_...", "signature": "<hex hmac>" }
```

The **only** path to `COMPLETED`. The signature must be
`HMAC_SHA256("<orderId>|<paymentId>", keySecret)`, where `orderId` is read from the
server's own record. An invalid signature returns 403, marks the payment FAILED,
releases the budget, restocks, and records a security incident.

### `GET /api/purchase-intents/:id`
Owner only.

---

## Merchant routes

### `POST /api/auth/login`
```jsonc
{ "email": "owner@techkart.demo", "password": "..." }
```
Returns `{ token, user }`. Wrong password and unknown email are indistinguishable in
both message and timing.

### `POST /api/auth/logout` · `GET /api/auth/me`

### `GET /api/dashboard/stats`
Totals, by-status breakdown, pending approvals, incidents, and live audit-chain status.

### `GET /api/transactions`
Scoped to the session's merchant.

### `GET /api/transactions/:id/timeline`
The full reconstruction: intent, decision with all 15 evaluated rules, risk factors,
payment, hash-chained events, and this transaction's integrity result.

### `GET /api/approvals/pending`

### `POST /api/purchase-intents/:id/approval`
Requires role `OWNER` or `APPROVER`.

```jsonc
{ "token": "<one-time token>", "approve": true }
```

Single-use, time-limited, tenant-bound. Budget is reserved at *this* moment — an
approval granted after the agent has spent its remaining budget elsewhere is still
refused.

### `GET /api/agents` · `POST /api/agents/:id/unquarantine`
Public keys are returned; there is no private material to withhold.

### `GET /api/policies` · `PATCH /api/policies`
`PATCH` requires role `OWNER`, bumps the version, and snapshots the previous one.

### `GET /api/security/incidents`

### `GET /api/audit/events` · `POST /api/audit/verify`
Verification recomputes every digest and checks linkage and sequence continuity.

---

## Demo routes

Only when `ENABLE_DEMO_ROUTES=true`. The config loader refuses to boot in production
with these enabled.

### `POST /api/demo/run`
Executes 14 scenarios as real signed requests through the real stack.

### `POST /api/demo/reset`
Resets demo agent state. Deliberately does **not** touch the audit chain.

---

## Rate limits

100 requests per 60 seconds, keyed by agent key id when present, otherwise by IP.
Exceeding returns 429 with a `Retry after Ns` message.
