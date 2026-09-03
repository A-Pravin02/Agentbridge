# AgentBridge

**The authorization layer for AI commerce.**

AI agents can now discover products, decide what to buy, and call payment APIs. The
uncomfortable part is what that implies: giving a language model the ability to spend
money means giving a language model financial authority.

AgentBridge separates those two things.

```
LLMs propose actions.  AgentBridge decides whether they happen.
```

The agent never holds spending authority. It submits a *proposal*; a deterministic
policy engine — with no model anywhere in the decision path — returns ALLOW,
REQUIRE_APPROVAL or BLOCK, and that verdict is enforced by the database, not by
convention.

---

## The problem

A typical agent-commerce integration looks like this:

```
AI Agent ──────────────────────────────► Payment API
```

Whatever guardrails exist live in the prompt. That means the security boundary is
natural language, and natural language is exactly what an attacker controls. A prompt
injection, a jailbreak, or plain model error becomes a purchase.

AgentBridge inserts an enforcement boundary that the model cannot talk its way past:

```
AI Agent → MCP tools → AgentBridge ─┬─ Ed25519 identity        (who is asking?)
                                    ├─ Permission passport     (what may it do?)
                                    ├─ Deterministic policy    (is this allowed?)
                                    ├─ Behavioural risk        (is this normal?)
                                    ├─ Atomic budget ledger    (is there room?)
                                    ├─ Human approval          (does someone agree?)
                                    ├─ Payment verification    (did money move?)
                                    └─ Hash-chained audit      (what happened?)
                                                │
                                                ▼
                                          Payment provider
```

---

## The insight

Most of the interesting failures are not "the policy was wrong". They are:

- The policy was *right*, but two requests raced and both passed the check.
- The agent said the payment succeeded, and the server believed it.
- The audit log said everything was fine, because nobody ever verified it.

So AgentBridge's design rule is: **every control must be enforced by something that
cannot be raced, argued with, or skipped.** In practice that means database
constraints, atomic conditional writes and cryptographic signatures — not application
if-statements.

Three examples of that rule in action:

| Control | Naive approach | What AgentBridge does |
|---|---|---|
| Daily spending limit | `SELECT` spend, compare, `INSERT` | One conditional `UPDATE` whose predicate *is* the limit, so the check and the increment are one atomic operation |
| Payment settlement | Trust a `status: success` field | HMAC-SHA256 over `orderId\|paymentId`, with the order id read from our own database |
| Audit integrity | Append rows and hope | SHA-256 chain over a gapless sequence, verified on demand by `POST /api/audit/verify` |

---

## What is actually built

Everything below is implemented and covered by tests. Nothing in this section is
aspirational — see [Limitations](#limitations) for what is not built.

**Authorization**
- Deterministic policy engine, 15 composable rules, zero LLM involvement
- Precedence: `BLOCK > REQUIRE_APPROVAL > ALLOW`, as an order-independent fold
- Full rule trace on every decision, including the checks that *passed*
- Policy versioning with immutable snapshots, so old decisions stay reproducible

**Identity**
- Ed25519 request signing. The server stores **only public keys** — nothing in the
  database can impersonate an agent
- Signature covers method, path, nonce, timestamp and a body digest
- Single-use nonces enforced by a unique index; mandatory idempotency keys

**Money**
- Integer minor units (paise) everywhere, with `CHECK` constraints in the schema
- Atomic per-agent daily ledger — the concurrency control point of the system
- Server-authoritative pricing: the agent supplies a product id, never a price

**Payments**
- Razorpay's real HMAC algorithms for both payment callbacks and webhooks
- Two settlement paths (signed callback, verified webhook), both cryptographically
  gated, converging on one private function
- Webhook replay rejection as a unique-constraint guarantee

**Human approval**
- Requires an authenticated merchant user with an approver role
- Single-use, time-limited, tenant-bound, one-time-token protected
- Budget is reserved at *approval* time, not evaluation time

**Audit**
- SHA-256 hash chain over `sequence | action | actor | entity | timestamp | metadata`
- Gapless sequence, so deletion is detectable
- Compare-and-swap chain head, so concurrent appends serialize instead of forking
- `POST /api/audit/verify` recomputes every digest

---

## Quick start

Requires Node 18+. No database server, no Docker, no cloud account.

```bash
git clone <this-repo> && cd PRAXIS-AI
npm run setup
```

`setup` installs dependencies, applies migrations to a local SQLite database, and
seeds the TechKart demo merchant. Then:

```bash
npm run dev
```

- Dashboard: <http://localhost:3000> — sign in as `owner@techkart.demo` / `techkart-demo-2026`
- API: <http://localhost:3001>

Run the whole verification suite:

```bash
npm run verify
```

CI runs the same command on every push (`.github/workflows/verify.yml`), so a
regression in any security invariant fails the build.

### See it defend itself

Open the dashboard → **Attack console** → **Run all scenarios**.

Fourteen scenarios execute as real signed HTTP requests against the real stack — the
same routes, hooks, services and database the demo uses. Ten of them are attacks.
Nothing is stubbed and no outcome is pre-decided; each scenario declares what it
expects and the runner compares that against what actually happened.

```
scenarios passed : 14/14
attacks stopped  : 10/10
```

| # | Scenario | Result |
|---|---|---|
| 1 | Legitimate purchase, ₹299 | COMPLETED — payment verified by signature |
| 2 | ₹1,499, above the per-transaction cap | BLOCKED |
| 3 | ₹499, above the approval threshold | REQUIRES APPROVAL |
| 4 | ₹450 in a category the agent may not buy | BLOCKED |
| 5 | **Agent forges a successful payment** | STOPPED — 403, status FAILED |
| 6 | **Agent replays a signed request** | STOPPED — nonce already consumed |
| 7 | **Agent tampers with a signed body** | STOPPED — body digest mismatch |
| 8 | **Agent omits its signature** | STOPPED — credentials are mandatory |
| 9 | **Agent sends a negative quantity** | STOPPED — 400, zero rows written |
| 10 | **Eight concurrent purchases race the daily cap** | STOPPED — cap held exactly |
| 11 | **Attacker edits an audit record** | DETECTED — `CONTENT_HASH_MISMATCH` |
| 12 | **Agent targets another merchant's product** | STOPPED — 404, no enumeration |
| 13 | **Agent approves its own purchase** | STOPPED — 401, session required |
| 14 | **Repeated attacks quarantine the agent** | QUARANTINED automatically |

---

## Demo merchant: TechKart

| Product | Price | Category | Outcome | Why |
|---|---|---|---|---|
| USB-C Cable | ₹299 | Electronics Accessories | ALLOW | within every limit |
| Premium Phone Case | ₹399 | Phone Accessories | ALLOW | within every limit |
| Premium Case | ₹499 | Phone Accessories | REQUIRE_APPROVAL | above the ₹400 approval threshold |
| Power Bank | ₹1,499 | Electronics | BLOCK | above the ₹500 per-transaction cap |
| Bluetooth Speaker | ₹2,999 | Electronics | BLOCK | far above the cap |
| Designer Watch | ₹450 | Luxury | BLOCK | category not permitted — isolates the category rule |

Each product is priced so that exactly one rule decides its fate, which makes the
demo legible.

---

## Architecture

A modular monolith. The valuable structural property is that all decision logic is
pure and I/O-free, so it is unit-testable and reproducible.

```
packages/                     pure, no I/O, heavily unit-tested
  shared-types/               enums, money, contracts, state transition table
  policy-engine/              evaluatePolicy() — 15 rules, deterministic
  threat-analyzer/            11 transparent behavioural rules → 0-100 score
  audit/                      hash chaining and verification
  payments/                   Razorpay HMAC signature algorithms

apps/
  api/                        Fastify + Prisma
    plugins/auth.ts           Ed25519 agent auth, merchant sessions, roles
    services/                 all business logic and transaction boundaries
      ledger-service.ts         ← atomic budget reservation
      audit-service.ts          ← sequenced, CAS-protected chain
      payment-service.ts        ← the only path to COMPLETED
      purchase-service.ts       ← orchestration
    routes/                   thin handlers, Zod-validated
  mcp/                        MCP server — signs as the agent, holds its key
  web/                        Next.js merchant dashboard
```

Read [docs/architecture.md](docs/architecture.md) for the full picture, and
[docs/security-architecture.md](docs/security-architecture.md) for the trust model.

---

## Tech stack

| Layer | Choice | Note |
|---|---|---|
| Backend | Node 18+, TypeScript (strict), Fastify | |
| ORM | Prisma | |
| Database | **SQLite** by default; PostgreSQL verified | see below |
| Payments | Razorpay test mode, or a local sandbox | verification is identical in both |
| Agent identity | Ed25519 (`node:crypto`) | server holds only public keys |
| AI integration | MCP (`@modelcontextprotocol/sdk`) | |
| Frontend | Next.js 16, React 19, Tailwind 4 | |
| Tests | Vitest — 179 tests | |

**On SQLite.** The default is SQLite so that `npm run setup` works with no external
services. Every concurrency control is written to be engine-agnostic — the budget
ledger uses an atomic conditional `UPDATE` rather than `SELECT … FOR UPDATE`, which is
correct on both engines and needs no special isolation level.

PostgreSQL is a first-class target: `npm run db:use:postgres` swaps the schema and
migrations, and the Postgres migration carries the same 18 `CHECK` constraints. **The
full suite — all 184 tests, every concurrency invariant included — passes against a
real Neon PostgreSQL instance as well as SQLite.** See
[docs/deployment.md](docs/deployment.md).

## Deploying

The API is a long-running Fastify process; the dashboard is a static Next.js app. They
want different hosts:

```
Browser → Vercel (dashboard) → Railway (API) → PostgreSQL
```

A root `Dockerfile` and `railway.json` deploy the API; `apps/web/vercel.json` deploys
the dashboard. The API **cannot** run on Vercel — serverless has an ephemeral
filesystem (SQLite dies), no persistent process (`app.listen` never starts), and no
long-lived timer (approval expiry never runs). Full walkthrough in
[docs/deployment.md](docs/deployment.md).

**On payments.** With `PAYMENT_MODE=sandbox` the *counterparty* is simulated, not the
*verification*. Signature checking is the same `verifyPaymentSignature` in both modes:
the same HMAC, the same timing-safe comparison, the same fail-closed behaviour when no
secret is configured. Supplying real Razorpay test keys changes which server mints
signatures and changes nothing about how they are checked.

---

## Testing

```bash
npm run test          # 179 tests
npm run test:coverage
npm run typecheck
```

| Suite | Tests | What it covers |
|---|---|---|
| `apps/api/tests/invariants.test.ts` | 29 | The ten security invariants, over real HTTP |
| `apps/api/tests/adversarial.test.ts` | 50 | Forged auth, replay, tampering, IDOR, webhooks, rate limits |
| `packages/policy-engine` | 36 | Every rule, precedence, determinism, boundary values |
| `packages/audit` | 24 | Canonicalisation, per-field digest coverage, tamper detection |
| `packages/payments` | 18 | Signature forgery, cross-order replay, fail-closed |
| `packages/threat-analyzer` | 22 | All behavioural rules |

The invariant suite is the important one. Each test corresponds to a property the
system claims, and it drives the real server:

1. A BLOCK can never result in a payment
2. An agent can never exceed its daily limit — *including under concurrency*
3. A revoked agent can never transact
4. No completion without a verified payment
5. One provider payment cannot settle two transactions
6. An approval cannot be reused
7. A client can never override the authoritative price
8. An agent cannot approve its own transaction
9. Audit tampering is always detected
10. Decisions are reproducible from the same policy version and context

---

## Documentation

| Document | Contents |
|---|---|
| [AUDIT_REPORT.md](AUDIT_REPORT.md) | The Phase 0 forensic audit of the previous build, with reproduced exploits |
| [SECURITY_AUDIT.md](SECURITY_AUDIT.md) | Red-team review of the current build |
| [docs/architecture.md](docs/architecture.md) | Components, data flow, boundaries |
| [docs/security-architecture.md](docs/security-architecture.md) | Trust model, identity, what is never trusted |
| [docs/threat-model.md](docs/threat-model.md) | 40 threats with mitigation and test case |
| [docs/policy-engine.md](docs/policy-engine.md) | All 15 rules, precedence, determinism contract |
| [docs/payment-security.md](docs/payment-security.md) | Settlement paths and signature verification |
| [docs/audit-system.md](docs/audit-system.md) | Chain construction and verification |
| [docs/mcp-security.md](docs/mcp-security.md) | Tool surface and confused-deputy defence |
| [docs/api.md](docs/api.md) | Endpoint reference |
| [docs/demo-script.md](docs/demo-script.md) | A timed walkthrough |
| [docs/deployment.md](docs/deployment.md) | PostgreSQL, real Razorpay keys, production checklist |
| [docs/PITCH.md](docs/PITCH.md) | The argument, condensed |
| [docs/COMPETITIVE_ANALYSIS.md](docs/COMPETITIVE_ANALYSIS.md) | What exists already, and where the gap actually is |
| [docs/BUSINESS_MODEL.md](docs/BUSINESS_MODEL.md) | AgentBridge evaluated as infrastructure |
| [docs/FINAL_REVIEW.md](docs/FINAL_REVIEW.md) | Self-assessment, scored, with the criticisms I expect |

---

## Limitations

Stated plainly, because a security project that overclaims is worse than one that
underclaims.

- **SQLite by default.** Fine for the demo and correct under the concurrency tests,
  but a single-writer engine. Production means PostgreSQL.
- **The sandbox payment provider is not Razorpay.** The verification code is real and
  is the same in both modes; the counterparty is not. Live test-mode keys have not
  been exercised end to end in this environment.
- **No multi-region, no HA, no queue.** A modular monolith, deliberately.
- **The threat analyzer is heuristic.** Transparent and explainable by design, but the
  thresholds are hand-tuned, not learned or empirically validated.
- **Approval delivery is in-dashboard.** No email or push; the one-time token is
  returned to the agent and pasted by the approver.
- **No key rotation flow.** Agent keys can be replaced by re-seeding, but there is no
  rotation endpoint or overlap window.
- **Rate limiting is in-process.** Fine for one instance; a shared store is needed
  behind more than one.
- **One known dependency advisory.** `deepmerge-ts`, reached only through the Prisma
  CLI (a dev dependency), fixed only in a Prisma 8 release candidate. Not in the
  runtime path; not shipping an RC for it.

---

## Roadmap

Ordered by what would matter most next.

1. PostgreSQL as the default, with the concurrency suite running against both engines in CI
2. Live Razorpay test-mode integration verified end to end
3. Agent key rotation with an overlap window, and a self-service credential endpoint
4. Approval delivery over email/Slack with signed deep links
5. Spend analytics: per-agent burn-down, anomaly review queue
6. Multi-merchant onboarding and a hosted control plane
7. Policy simulation — "what would this change have blocked last week?"

---

## License

MIT
