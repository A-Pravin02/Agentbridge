# Architecture

A modular monolith. Deliberately — the system is small, the transaction boundaries
matter, and distributing it would buy nothing but latency and partial failure.

## Layout

```
packages/                     PURE. No I/O. Heavily unit-tested.
  shared-types/               enums, money, contracts, state transition table
  policy-engine/              evaluatePolicy() + state machine
  threat-analyzer/            11 behavioural rules -> 0-100 score
  audit/                      hash chaining and verification
  payments/                   Razorpay HMAC algorithms + providers

apps/
  api/
    config.ts                 Zod-validated environment; refuses bad config at boot
    db.ts                     Prisma client, JSON helpers, ledger-day key
    server.ts                 buildServer() factory
    lib/
      crypto.ts               Ed25519, scrypt, token hashing, canonical request
      errors.ts               typed errors -> HTTP status + stable code
    plugins/
      auth.ts                 agent Ed25519 auth, merchant sessions, roles
    services/                 ALL business logic and transaction boundaries
      ledger-service.ts       atomic budget reservation
      audit-service.ts        sequenced, CAS-protected chain append
      payment-service.ts      order creation, verification, webhooks
      purchase-service.ts     orchestration, state transitions
      approval-service.ts     human-in-the-loop
      policy-service.ts       loads policy state, shapes engine input
      threat-service.ts       gathers behavioural data
      security-service.ts     incidents, escalation, quarantine
      idempotency-service.ts  mandatory idempotency
    routes/                   THIN. Validate, delegate, serialize.
    tests/                    invariants + adversarial, over real HTTP

  mcp/                        MCP server. Holds the agent key, signs every call.
  web/                        Next.js merchant dashboard.
```

## The layering rule

**Decision logic is pure; I/O lives in services; routes are thin.**

That is the one structural property worth protecting. It means the policy engine and
threat analyzer can be exhaustively unit-tested with no database, and their output is
reproducible. Every audit finding about the previous build traced back to business
logic inlined into route handlers with no transaction boundaries.

Concretely:

- A route never queries the database directly.
- A service never reads `request` or writes `reply`.
- A package never imports Prisma.

## Request flow: create → evaluate → pay

```
POST /api/purchase-intents
  |
  ├─ rate limit                          per agent key, else per IP
  ├─ raw body capture                    needed for signature verification
  ├─ authenticateAgent (preHandler)      Ed25519 + nonce + timestamp + status
  ├─ Zod schema                          strict; unknown keys rejected
  ├─ withIdempotency                     mandatory key; claims before executing
  └─ createPurchaseIntent
       ├─ load product (authoritative price)
       ├─ tenancy check: product.merchantId === agent.merchantId
       ├─ amountMinor = multiplyMinor(priceMinor, quantity)
       └─ audit: PURCHASE_INTENT_CREATED

POST /api/purchase-intents/:id/evaluate
  |
  └─ evaluatePurchaseIntent
       ├─ ownership check
       ├─ re-derive amount from CURRENT price
       ├─ transition CREATED -> EVALUATING
       ├─ performThreatAnalysis            (one batched round trip)
       ├─ evaluatePolicy                   pure; advisory usage snapshot
       ├─ if ALLOW: reserveBudget          ATOMIC. The authority.
       │    └─ if refused: downgrade to BLOCK
       ├─ quarantine if risk is CRITICAL
       └─ transaction:
            ├─ transition -> AUTHORIZED | REQUIRE_APPROVAL | BLOCKED
            ├─ write Authorization (full rule trace, policy version)
            └─ create Approval if needed (one-time token)

POST /api/purchase-intents/:id/payment-order
  |
  └─ createPaymentOrder
       ├─ re-check: still AUTHORIZED, authorization not expired, agent active
       ├─ conditional stock decrement      cannot oversell
       ├─ provider.createOrder()
       └─ transition -> PAYMENT_PENDING

POST /api/purchase-intents/:id/verify-payment
  |
  └─ verifyAndSettle
       ├─ HMAC over "<ourOrderId>|<paymentId>"     THE GATE
       ├─ on failure: FAILED, release budget, restock, incident
       └─ settleVerified (private)
            └─ PAYMENT_PENDING -> PAYMENT_PROCESSING -> COMPLETED
```

## State machine

Enforced on **every** transition, inside the transaction that performs the write:

```ts
await transitionIntent(tx, id, PurchaseStatus.CREATED, PurchaseStatus.EVALUATING);
```

`transitionIntent` does two things:

1. `assertTransition(from, to)` against `VALID_TRANSITIONS`.
2. `updateMany({ where: { id, status: from } })` — pins the expected current status,
   so a concurrent writer that changed the row first causes zero rows to match and the
   operation fails rather than silently clobbering.

There are no raw status writes anywhere in the codebase.

```
CREATED ──► EVALUATING ──┬──► AUTHORIZED ──► PAYMENT_PENDING ──► PAYMENT_PROCESSING ──► COMPLETED
                         │         ▲                    │                  │
                         ├──► REQUIRE_APPROVAL           └──► FAILED ◄──────┘
                         │         │  └──► DENIED
                         │         └──► APPROVED ──┘
                         └──► BLOCKED
```

Terminal: `COMPLETED`, `BLOCKED`, `DENIED`, `FAILED`, `EXPIRED`, `CANCELLED`.

## Data model

| Table | Role |
|---|---|
| `merchants`, `merchant_users`, `sessions` | Tenancy and human identity |
| `agents`, `agent_permissions` | Agent identity (public key only) and passport |
| `policies`, `policy_versions` | Current policy + immutable historical snapshots |
| `products` | Catalogue; the authoritative price |
| `purchase_intents` | The proposal and its lifecycle |
| `authorizations` | One recorded decision, with the full rule trace |
| `approvals` | Human-in-the-loop, one-time token, deadline |
| **`agent_daily_ledger`** | **The concurrency control point** |
| `payments` | Provider order and payment ids; unique on both |
| `webhook_events` | Delivery log; unique on `(provider, eventId)` |
| `audit_events`, `audit_chain_head` | Hash-chained log and its CAS tip |
| `security_incidents`, `threat_assessments` | Behavioural history |
| `idempotency_records`, `consumed_requests` | Retry safety and replay protection |

Money is `Int` minor units everywhere, with `CHECK` constraints.

## Where each guarantee actually lives

Worth being explicit, because "we validate that" is a weaker claim than "the database
refuses it".

| Guarantee | Enforced by |
|---|---|
| Daily spend cap | Atomic conditional `UPDATE` predicate |
| Transaction count cap | Same predicate |
| One payment settles once | `UNIQUE(provider_payment_id)` |
| Webhook replay rejection | `UNIQUE(provider, provider_event_id)` |
| Request nonce is single-use | `UNIQUE(agent_id, request_id)` |
| Approval is single-use | Conditional status update |
| No negative money | Zod + `multiplyMinor` + `CHECK` |
| No illegal state change | `assertTransition` + status-pinned update |
| Audit chain does not fork | CAS on `audit_chain_head` |
| Audit deletion is detectable | Gapless `sequence` |
| Agent identity | Ed25519 signature |
| Payment settlement | HMAC-SHA256 |

## Performance

- Threat analysis is one batched `$transaction` of seven reads, not seven round trips.
- Budget reservation is one statement.
- Policy evaluation is pure and in-memory — microseconds.
- Audit verification streams in pages of 500, so memory is bounded regardless of chain
  length.
- Indexed: `(agentId, status, createdAt)`, `(merchantId, createdAt)`,
  `(entityId, sequence)`, `(action, sequence)`, `(merchantId, category)`, plus every
  unique constraint above.

The dominant cost per evaluation is the audit appends, which serialize on the chain
head by design. That is a deliberate trade: a globally ordered, verifiable log is
worth more here than append throughput.
