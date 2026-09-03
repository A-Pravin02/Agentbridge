# AgentBridge — Repository Forensics & Security Audit

**Audit date:** 2026-09-03
**Commit audited:** `fb183c3` ("Optimize AgentBridge project")
**Auditor role:** lead architect / application-security engineer / QA
**Method:** full source read of every non-vendored file, plus **live black-box exploitation against a running instance** (`apps/api` on :3001, seeded SQLite DB). Every finding marked **[VERIFIED]** was reproduced against the running server, not inferred from reading code. The database was snapshotted before testing and restored afterwards; the working tree is unmodified.

---

## Executive summary

AgentBridge has a **genuinely good idea and a genuinely good skeleton**. The separation of a pure, deterministic policy engine from the transport layer is the right architecture, and it is real code, not a README claim. 62 unit tests pass.

But the audit found that **the three properties the project's pitch rests on are not actually true today**:

| Claimed property | Reality |
|---|---|
| "An agent can never spend above its authorized daily limit" | **False — verified.** 8 concurrent requests authorized **₹2,394 against a ₹2,000/day cap** and **6 transactions against a 5/day limit**. |
| "Tamper-evident audit trail" | **False — verified.** `GET /api/audit/verify` returns `TAMPER_DETECTED` on a completely untouched database. The chain has never verified successfully, at any point in the project's history. |
| "Payment is verified server-side; never trust frontend success" | **False — verified.** `POST /:id/complete` with an invented payment ID marks the transaction `COMPLETED`. There is no payment provider in the codebase at all. |

In addition, **there is no agent authentication whatsoever**. An agent's identity is a plain string in a JSON body. `agentId` is asserted by the caller and never proven. Request signing exists in code but is **off by default** and, even when on, is **trivially bypassed by omitting a header** (verified).

**The good news:** every one of these is fixable, and the fixes are exactly the work that makes the demo compelling. The gap between "impressive-looking" and "actually correct" is where this project's judge-facing story lives.

---

## A. Current architecture

Modular monorepo, npm workspaces. This part is sound.

```
packages/                        PURE, no I/O, unit-tested  ✅
  shared-types/       500 LoC    enums, interfaces, VALID_TRANSITIONS map
  policy-engine/      200 LoC    evaluatePolicy() + state machine (31 tests)
  threat-analyzer/    400 LoC    8 composable risk rules      (some tests)
  audit/              120 LoC    SHA-256 hash chaining        (some tests)

apps/
  api/               2100 LoC    Fastify + Prisma  ← ALL security gaps live here
    routes/purchases.ts   820    intent → evaluate → approve → execute → complete
    routes/dashboard.ts   519    16 endpoints, incl. 2 unauthenticated demo endpoints
    integrity-service.ts  318    timestamp / replay / idempotency / HMAC
    security-service.ts   233    quarantine + escalation
    threat-service.ts     232    DB queries → pure analyzer
    decision-orchestrator 163    combines signals; precedence documented ✅
  mcp/                232 LoC    hand-rolled JSON-RPC over stdio  ← broken, see D-1
  web/               1400 LoC    single-file Next.js dashboard, 6 tabs
```

**Architectural strength worth keeping:** the policy engine and threat analyzer are pure functions with zero I/O. This is the single best decision in the repo — it makes authorization logic testable, reproducible, and explainable to a judge. Do not refactor this away.

**Architectural weakness:** the API layer bypasses that discipline entirely. All the DB reads, all the state transitions, and all the security checks are inlined into route handlers with no service layer, no repository layer, and no transaction boundaries.

---

## B. Implemented features (verified present and working)

- ✅ Deterministic policy engine — no LLM in the decision path. **The core thesis is honoured.**
- ✅ Server-authoritative pricing. The agent supplies `productId`; the server reads `product.price`. Agent-supplied prices are structurally impossible (`purchases.ts:76`).
- ✅ `merchantId` derived from the product record, ignoring the caller's claim (`purchases.ts:81`).
- ✅ Explicit state machine with a `VALID_TRANSITIONS` map and `canTransition()` guards.
- ✅ Decision precedence orchestrator with a documented priority ladder; a hard policy BLOCK is never overridden by risk. Correct.
- ✅ Behavioral threat engine: 8 transparent, non-ML rules producing an explainable 0–100 score.
- ✅ Agent quarantine + escalation state machine.
- ✅ Timing-safe HMAC comparison (`timingSafeEqual`), CSPRNG secrets (`randomBytes(32)`).
- ✅ Generic external error messages that do not leak whether an agent exists.
- ✅ 62 passing unit tests across the three pure packages.
- ✅ Working merchant dashboard UI with 6 tabs.

---

## C. Missing features (claimed but absent)

Verified by dependency scan across all `package.json`, `*.ts`, `*.tsx`, `*.prisma`:

| README / brief claims | Actually in the repo |
|---|---|
| PostgreSQL | **SQLite.** `provider = "sqlite"`, `file:./dev.db`. No Postgres anywhere. |
| Razorpay test mode | **Absent.** No `razorpay` package. Payment IDs are `` `pay_test_${Date.now()}` ``. |
| Payment signature verification | **Absent.** No signature check exists. |
| Webhooks (`POST /webhooks/razorpay`) | **Absent.** No webhook endpoint, no replay protection for one. |
| Socket.IO / real-time | **Absent.** Zero occurrences. Dashboard uses polling. |
| shadcn/ui | **Absent.** Hand-written Tailwind; `web` deps are only next/react. |
| Zod (or any schema validation) | **Absent.** Zero validation on any endpoint. See D-4. |
| Rate limiting | **Absent.** Verified: 30 rapid unauthenticated requests → 30×200. |
| Merchant/user authentication | **Absent.** One static admin key; no users, no sessions, no JWT. |
| Agent authentication | **Absent in practice.** See E-1. |
| `npm run dev` (per README setup) | **Script does not exist** in root `package.json`. README setup is broken. |

Also missing vs. the brief: currency validation, time-of-day restrictions, velocity limits as policy rules, policy versioning, approval expiry, `POST /audit/verify`, `/ready` endpoint, structured request-scoped logging, `docs/` (does not exist).

---

## D. Critical bugs

**D-1 — The MCP server cannot talk to the API at all. [VERIFIED by code path]**
`apps/mcp/src/index.ts:8` sets `API_BASE = 'http://localhost:3001'` and then calls `${API_BASE}/products`, `${API_BASE}/purchase-intents`, `${API_BASE}/agents`. Every API route is registered under the `/api` prefix (`apps/api/src/index.ts:62-64`). **Every MCP tool call 404s.** The AI-agent integration — the project's headline — is non-functional. `get_agent_limits` additionally targets a dashboard endpoint that returns all agents and filters client-side.

**D-2 — The dashboard's own purchase flow is broken. [VERIFIED]**
`/evaluate` hard-requires an `X-Timestamp` header (`purchases.ts:163`). `apps/web/src/lib/api.ts` never sends one. Live result:

```
POST /api/purchase-intents/:id/evaluate   (headers: Content-Type only)
→ 400 {"success":false,"error":"Request integrity check failed","decision":"BLOCK"}
```

**Every "Run Demo" click in the UI fails.** Worse, each failure calls `recordSecurityIncident(EXPIRED_REQUEST)`; at 5 incidents in 24h the escalation rule **permanently blocks the demo agent** (`security-service.ts:118`). The demo bricks itself after five clicks.

**D-3 — The audit chain reports TAMPERED on a pristine database. [VERIFIED]**

```
GET /api/audit/verify
→ {"valid":false,"totalEvents":89,"brokenAt":0,
   "reason":"Content hash mismatch at index 0. Event payload has been tampered with."}
```

Root cause isolated by brute-force search over candidate timestamps: `audit.ts:31` hashes `new Date().toISOString()` read in JS, while `createdAt` is written independently by Prisma's `@default(now())`. **The two clock reads differ (measured: 2 ms).** The verifier recomputes from `createdAt`, so the stored hash can never match — for any event, ever. The flagship "tamper-evident" feature has never worked, and because it always reports tampering it also cannot distinguish real tampering. Scenario 10 of the intended demo is undemonstrable.

**D-4 — No input validation anywhere; negative quantity is a total spending-limit bypass. [VERIFIED]**
No Zod, no Fastify schemas, no manual range checks. `amount = product.price * quantity` with an unvalidated `quantity`:

```
POST /purchase-intents  {"productId":"prod_usb_cable","quantity":-20}
→ 200  amount = -5980
POST /:id/evaluate  → decision = ALLOW,  status = AUTHORIZED
dailySpent as computed by the policy engine = Rs. -5980
```

A single negative integer authorizes a purchase **and grants the agent ₹5,980 of extra headroom on top of its ₹2,000 cap**, because `dailySpent` is a naive `reduce((s,i)=>s+i.amount)` over stored amounts. This is a complete bypass of the system's central control via one unvalidated field.

**D-5 — Audit chain forks under concurrency. [VERIFIED — 3 forks observed]**
`recordAuditEvent` does `findFirst(orderBy createdAt desc)` then `create` with no transaction or lock. Concurrent writers read the same tip and both link to it. Measured on the test corpus: 3 distinct `previousHash` values reused by more than one event out of 89. Chain ordering is also inferred from `createdAt`, which is **not unique and has no tiebreaker** — there is no sequence column.

**D-6 — `hashRequestBody` is not canonical and crashes on a null body.**
`integrity-service.ts:311`: `JSON.stringify(body, Object.keys(body as object).sort())`. The second argument is a *replacer allow-list applied at every nesting depth*, not a key sorter — it does not sort output, and it silently strips nested keys not present at the top level. `Object.keys(null)` throws `TypeError` → unhandled 500 on a null body. Two semantically different payloads can hash identically.

**D-7 — Double `update` calls create phantom state transitions.**
`/approve` writes `APPROVED` then immediately `AUTHORIZED` in two separate un-transacted statements (`purchases.ts:462-467`); `/complete` does the same for `PAYMENT_PROCESSING` → `COMPLETED`. A crash between them leaves the row in a state no reader expects, and neither pair is guarded by `canTransition()` — the state machine is imported but **only enforced on the `CREATED → EVALUATING` edge**. Every other transition in the codebase is an unguarded raw write.

---

## E. Security vulnerabilities

Ordered by severity. Severity assigned by exploitability × impact on the system's stated guarantee.

### E-1 — CRITICAL — No agent authentication. Identity is a string in a JSON body.

The entire zero-trust story rests on knowing which agent is asking. It doesn't.

- `signingSecret` is **nullable** and the seed **never sets one**.
- `ENFORCE_REQUEST_SIGNING` defaults to **false** (`security-config.ts:48`, requires `ENFORCE_SIGNING === 'true'`).
- Even with signing enabled, verification is wrapped in `if (requestId && headers['x-timestamp'])` (`purchases.ts:196`) — **omitting `X-Request-ID` skips both replay protection and signature verification.** [VERIFIED: a request with only `X-Timestamp` sailed through to `AUTHORIZED`.]
- `POST /purchase-intents` performs **no integrity checks at all** — no timestamp, no replay, no signature.

**Impact:** anyone who can reach the API can transact as any agent. Every downstream control (limits, categories, quarantine) is decoration.

### E-2 — CRITICAL — Payment completion is entirely forged. [VERIFIED]

```
POST /purchase-intents/:id/complete  {"providerPaymentId":"pay_ATTACKER_NEVER_PAID"}
→ 200  status: "COMPLETED"
```

No payment provider is contacted. No signature is verified. No webhook exists. The endpoint accepts an attacker-chosen payment ID and, if omitted, **fabricates one from `Date.now()`**. This directly violates the project's own RULE 4 and invariant #4 ("a transaction can never be completed without verified payment"). Goods ship; no money moves.

### E-3 — CRITICAL — Concurrent spending completely defeats the daily limit. [VERIFIED]

The marquee Phase 8 attack succeeds. Reproduction (clean daily window, policy `maxTxn ₹500 / daily ₹2,000 / 5 per day`):

```
8 intents of Rs.399, evaluated CONCURRENTLY
DECISIONS: { ALLOW: 6, BLOCK: 2 }
AUTHORIZED total = Rs.2394   vs daily cap Rs.2000     *** BREACHED ***
AUTHORIZED count = 6         vs limit of 5            *** BREACHED ***
```

Cause: read-then-decide-then-write with no transaction, no row lock, no atomic counter, and no unique constraint. `dailySpent` is recomputed by scanning `purchaseIntent` rows (`purchases.ts:301`) outside any isolation boundary. SQLite's single-writer model does not help, because the *reads* are what race. Invariant #2 is violated.

### E-4 — CRITICAL — Human approval requires no human, and no authentication. [VERIFIED]

```
POST /purchase-intents/:id/approve  {"approvedBy":"the-agent-itself"}
   (no admin key, no session, no identity)
→ 200,  status: AUTHORIZED
```

`ADMIN_ENDPOINTS` only covers `/api/security/agents` and `/api/policies` (`index.ts:17-20`). `/api/purchase-intents/*` is **not** in that list, so the admin hook never fires — the frontend sends `x-admin-key` but **the server never checks it on this route**. The approval is also not single-use, not time-limited, not bound to an approver identity, and not bound to a nonce. Invariant #8 ("an agent cannot approve its own transaction") is violated; the entire human-in-the-loop control is a no-op.

### E-5 — CRITICAL — The admin key is published to the browser and has a hardcoded fallback.

`apps/web/src/lib/api.ts:5`: `process.env.NEXT_PUBLIC_ADMIN_KEY || 'dev-admin-key-change-in-production'`. `NEXT_PUBLIC_*` is **inlined into the client bundle** — the privileged key is readable by anyone who opens devtools. The server-side fallback (`index.ts:14`) is the same literal string, so an unconfigured deployment ships with a publicly known admin credential.

### E-6 — HIGH — Unauthenticated endpoints that erase security state. [VERIFIED]

```
POST /api/demo/reset  (no auth)  → 200
```

`dashboard.ts:466` sets `status: 'ACTIVE'`, zeroes `securityViolationCount` and `severeThreatCount`, and **`deleteMany`s all `SecurityIncident` and `ConsumedRequest` rows for the agent**. A quarantined attacker un-quarantines themselves and wipes the replay-protection ledger with one unauthenticated POST. `/api/demo/simulate-attack` is likewise open and writes forged BLOCKED intents and forged security incidents into the real tables.

### E-7 — HIGH — No cross-merchant isolation (IDOR / confused deputy).

`POST /purchase-intents` takes `agentId` and `productId` and **never checks `agent.merchantId === product.merchantId`**. An agent registered to merchant A can create intents against merchant B's products; the merchant policy applied is then B's, chosen by `intent.merchantId`. All `GET` endpoints (`/agents`, `/transactions`, `/audit-events`, `/policies`, `/approvals/pending`, `/security/*`) are unauthenticated and **return every merchant's data**. There is no tenant scoping anywhere in the codebase.

### E-8 — HIGH — Idempotency is opt-in by the attacker.

`/execute` only consults `checkIdempotency` **if the client chooses to send `Idempotency-Key`** (`purchases.ts:513`). An attacker simply omits it. There is no unique DB constraint backing single-execution — the only real protection is the `status === AUTHORIZED` check, which is itself a read-then-write race. Phase 7's requirement ("a request repeated 20 times must not create multiple payments") is not structurally guaranteed.

### E-9 — HIGH — Stock check and decrement are not atomic; no non-negative constraint.

`purchases.ts:592` checks `product.stock < quantity`, then `purchases.ts:598` issues `{ decrement: quantity }`. Concurrent executes oversell. Nothing in the schema prevents `stock` going negative, and the decrement is never compensated if the subsequent transaction create fails.

### E-10 — MEDIUM — No rate limiting anywhere. [VERIFIED: 30/30 × 200]

No `@fastify/rate-limit`. Unauthenticated `POST /purchase-intents` is an unbounded write amplifier: each call creates a row, and `/evaluate` triggers ~7 DB queries plus 3–5 audit writes. Trivial DoS and unbounded storage growth.

### E-11 — MEDIUM — Committed database.

`apps/api/prisma/dev.db` is tracked in git (196 KB, modified across 3 commits). `.gitignore`'s `prisma/*.db` pattern contains a slash and is therefore anchored to the repo root, so it does not match `apps/api/prisma/dev.db`. Any secret written to that DB is in history permanently.

### E-12 — MEDIUM — Secrets and PII in logs.

`Fastify({ logger: true })` with default settings logs full request headers, including `x-admin-key` and `x-agent-signature`, at info level. No redaction configuration.

### E-13 — MEDIUM — CORS null-origin allowance.

`index.ts:52`: `if (!origin || allowedOrigins.includes(origin))`. Accepting requests with no `Origin` header is correct for server-to-server callers but means the allow-list provides no protection against non-browser clients — acceptable here only because there are no cookies, but it should be a stated decision, not an accident.

### E-14 — LOW — Threat-assessment revalidation result is discarded.

`purchases.ts:566`: if the assessment is stale, `performThreatAnalysis` re-runs, but only `QUARANTINE_AGENT` blocks. A fresh **HIGH** threat (which would have forced `REQUIRE_APPROVAL` at evaluate time) is computed, stored, and then **ignored** — payment proceeds. Stale-policy protection is incomplete.

### E-15 — LOW — Authorization expiry is checked against the wrong record.

`purchases.ts:551` takes `authorizations[length-1]` — array order comes from an unordered Prisma `include`, not a sort. With multiple authorizations, expiry may be checked against the wrong one.

**Not vulnerable (checked and clear):**

- SQL injection — Prisma parameterizes throughout; no raw SQL exists.
- Agent-supplied price manipulation — structurally prevented. Correctly built.
- `signingSecret` exposure via `/api/agents` — explicitly excluded by `select`. Correct.
- XSS — React escapes by default; no `dangerouslySetInnerHTML`.
- SSRF — no server-side fetch of user-supplied URLs.

---

## F. Architectural weaknesses

1. **No service layer.** Route handlers are 100–300 lines each, mixing HTTP concerns, security checks, DB access, business rules, and audit writes. `purchases.ts` is 820 lines. Business logic cannot be unit-tested without HTTP.
2. **No transaction boundaries.** Not a single `prisma.$transaction` in the codebase. Every multi-step operation is a sequence of independent writes — the direct cause of E-3, D-5, D-7, and E-9.
3. **The state machine is imported but not enforced.** `canTransition` guards exactly one edge. Every other transition is a raw `update`, so the "explicit lifecycle" is documentation, not a control.
4. **Security depends on caller-supplied headers.** Optional headers gate mandatory checks (E-1). Controls must be enforced by the framework, not requested by the client.
5. **Derived state is recomputed by full scan.** `dailySpent` scans intents on every evaluation — both a correctness hazard (E-3, D-4) and an O(n) cost.
6. **Duplicated limit semantics.** `Agent.status`, `AgentPermission.*`, and `Policy.*` overlap; the effective limit is `Math.min()`-ed at three call sites with no single source of truth.
7. **Hand-rolled MCP protocol.** 232 lines reimplementing JSON-RPC instead of the official `@modelcontextprotocol/sdk`. It silently drops unknown methods and has no schema enforcement — a judge who knows MCP will notice.

---

## G. Scalability problems

- SQLite: single writer, no true concurrency, no `SELECT … FOR UPDATE`. The correct fix for E-3 (row locking / serializable isolation) **is not expressible on SQLite**. Migrating to PostgreSQL is a prerequisite, not a nice-to-have.
- `recordAuditEvent` serializes on a global chain tip — every write reads the single latest row. This is an inherent throughput ceiling and the source of D-5.
- Missing indexes: `audit_events(createdAt)` (verification scans and sorts the full table), `transactions(purchaseIntentId)`, `agent_permissions(agentId)`.
- `/audit/verify` loads the entire table into memory with no pagination or checkpointing.
- Threat analysis issues ~7 separate queries per evaluation, several overlapping.

---

## H. Data integrity problems

- Money stored as `Float`. **Binary floating point must never represent currency** — accumulation error is guaranteed, and `dailySpent` is a running sum of floats compared against a limit. Use integer minor units (paise).
- No `CHECK` constraints: `quantity`, `amount`, `price`, `stock` may all be negative (D-4 exploits exactly this).
- Arrays stored as JSON strings (`allowedCategories`) — unqueryable, unvalidated, silently `[]` on parse failure (`db.ts:20`), so a corrupt value **fails open into "no categories allowed"** but is indistinguishable from a legitimately empty list.
- No unique constraint on `(purchaseIntentId)` for transactions — nothing structurally prevents two payments for one intent.
- No `onDelete` behaviour declared on any relation.
- `Approval` has no `expiresAt`, violating Phase 12's "time-limited" requirement.
- Audit events have no monotonic sequence number; chain order rests on a non-unique timestamp.

---

## I. Payment risks

There is no payment integration to assess. What exists is a stub that **fabricates success**:

- No Razorpay SDK, no order creation, no key handling.
- `providerPaymentId` is attacker-supplied or `` `pay_test_${Date.now()}` ``.
- No amount re-validation against the provider, no currency validation (`currency` is copied from the product and never checked against an allow-list).
- No webhook endpoint → no webhook signature verification, no webhook idempotency, no webhook replay protection. Threats 15/16 of the brief have zero coverage.
- Stock is decremented **before** any payment exists, and never restored on failure.

---

## J. AI-agent security risks

- **The agent is fully trusted for identity** (E-1). The threat model treats the agent as potentially compromised; the implementation does not.
- **Prompt-injection reachability:** a compromised agent can call `/purchase-intents` with any `agentId`, `productId`, and `quantity`. Two of those three are unvalidated. Injection converts directly into an authorized purchase via D-4.
- **The agent can approve its own purchases** (E-4) — the confused-deputy case the approval system exists to prevent.
- **The agent can clear its own quarantine** (E-6).
- **Mitigated correctly:** the agent cannot influence price, cannot set `merchantId`, and cannot reach an `execute_payment()` primitive. Credit where due — the tool surface design is right even though its enforcement is not.

---

## K. MCP security risks

- **The MCP server does not function** (D-1) — every tool 404s.
- **No authentication on the MCP↔API boundary.** `agentId` is a *tool argument chosen by the LLM*. The model literally selects which identity to act as. This is the confused-deputy problem in its purest form.
- **No schema validation** beyond advisory JSON Schema in the tool listing; arguments are passed through untyped (`args: any`) with no range or type enforcement.
- **No `/evaluate` tool**, so an agent using MCP can create an intent but can never obtain a decision. The advertised agent journey is incomplete.
- **Tool descriptions are unbounded free text** returned to the model — a malicious product name/description in the catalog is echoed straight into the model's context (`search_products` returns raw rows). Malicious merchant metadata (threat 36) has no mitigation.
- **Correct choice retained:** no `execute_payment()` tool is exposed. Keep it that way.

---

## L. Authentication / authorization weaknesses

| Principal | Authentication | Authorization |
|---|---|---|
| Agent | **None** (string in body) | Permission rows exist but are keyed on an unproven identity |
| Merchant user | **None** — no user model at all | None |
| Admin | Single static shared key, hardcoded fallback, **shipped to the browser** | Covers 2 of 16 mutating routes |
| Payment provider | N/A — none exists | N/A |

Authentication and authorization are not separated because authentication does not exist. Consequences: IDOR on every `GET` (E-7), vertical privilege escalation via unprotected `/approve` (E-4), and horizontal escalation via unscoped cross-merchant access (E-7).

---

## M. Auditability weaknesses

- **The chain does not verify** (D-3) — the headline feature is inoperative.
- **The chain forks under concurrency** (D-5).
- **No sequence number**; ordering depends on a non-unique `createdAt`.
- **No `POST /audit/verify`** endpoint per the brief (only `GET`), and no per-transaction verification.
- **Audit writes are not transactional with the state changes they describe** — a crash between the `update` and the `recordAuditEvent` produces a state change with no audit record. The audit trail is therefore not a reliable reconstruction of history.
- Audit rows are **mutable and deletable** by the application's own DB user; hash chaining detects tampering but only if verification works, which it doesn't.
- **Positive:** actor/actorType/entityId/metadata modelling is good, coverage of security events is broad (24 audit actions), and `serializeMetadata` key sorting is the right instinct.

---

## N. Testing weaknesses

```
62 tests, 3 files, all passing — 100% of them in pure packages.
packages/policy-engine   31 tests   ✅
packages/threat-analyzer ~20 tests  ✅
packages/audit           ~11 tests  ✅
apps/api                  0 tests   ❌
apps/mcp                  0 tests   ❌
apps/web                  0 tests   ❌
```

**Zero tests cover any code path where a real vulnerability was found.** Specifically absent: integration tests, concurrency tests, idempotency tests, replay tests, authorization/IDOR tests, state-machine enforcement tests, and every one of the 10 security invariants from Phase 22. The audit package's tests verify `verifyChainIntegrity` on hand-built fixtures — which is exactly why they pass while the production chain has never verified.

Tooling gaps: no coverage reporting, no lint on `apps/api` or `packages/*` (only `apps/web` has ESLint), no CI, and `npm test` is not a script.

---

## O. UX / demo weaknesses

- **The demo does not run.** The dashboard's evaluate call 400s every time (D-2), and self-bricks after 5 attempts.
- **`/demo/simulate-attack` is theatre, not defence.** It does not exercise a single real control — it `create`s pre-labelled `BLOCKED` rows and calls `recordSecurityIncident()` directly. Nothing is actually attacked and nothing actually defends. A judge who asks "what did the system stop?" gets the honest answer "nothing — those rows were inserted already blocked." **This is the most dangerous thing in the repo from a credibility standpoint**, because it looks like a working defence demo and isn't.
- Of the brief's 10 demo scenarios: 1 (normal purchase) is broken by D-2; 5 (price manipulation) genuinely works; **2, 3, 4, 6, 7, 8, 9, 10 either fail or would demonstrate the attacker winning.**
- No transaction timeline view (Phase 19's "most important screen") — `/transactions/:id/replay` returns the data but no UI renders it as a timeline.
- `apps/web/src/app/page.tsx` is a single 1,387-line component.

---

## P. Production-readiness score

| Dimension | Score | Note |
|---|---:|---|
| Authentication | 0/10 | Does not exist for any principal |
| Authorization | 2/10 | Correct model, unenforced |
| Payment security | 0/10 | Forged completion, no provider |
| Concurrency correctness | 1/10 | Core limit breached under load (verified) |
| Data integrity | 3/10 | Floats for money, no constraints |
| Auditability | 2/10 | Never verifies; forks |
| Input validation | 0/10 | None; directly exploitable |
| Observability | 2/10 | Default logger, leaks headers |
| Testing | 3/10 | Good unit tests, zero integration/security tests |
| Infrastructure | 2/10 | SQLite, committed DB, no CI |
| Architecture | 6/10 | Genuinely good bones |
| **Overall** | **2 / 10** | Not deployable. A functional prototype with a correct thesis and unenforced controls. |

## Q. Hackathon-winning potential score

**Current state: 4 / 10.** The pitch is excellent and the architecture diagram is real, but the live demo fails on click one, the flagship audit feature reports failure on an untouched DB, and any judge who probes concurrency or approval auth finds the system's central claim is false. The "attack simulation" inviting exactly that scrutiny makes this materially worse, not better.

**Realistic ceiling after remediation: 9 / 10.** Nothing here requires a rewrite. The pure-package architecture is exactly right, the policy engine is real, the server-authoritative pricing is real, and the decision precedence is correctly designed. Every critical finding is a *missing enforcement*, not a wrong design. And the fixes are inherently demoable: a live, honest attack console that runs real requests against real controls and *shows them being stopped* is a far stronger artifact than the current scripted one.

**The single highest-leverage change:** turn the ten security invariants from Phase 22 into executable tests, then make them pass. Today, **eight of the ten are provably violated.** Invariant #7 (price authority) and the BLOCK-precedence half of #1 are the two that genuinely hold.

---

## Prioritized remediation plan

**P0 — required before any demo (correctness of the core claim)**

1. Migrate SQLite → PostgreSQL. Prerequisite for #2, and it aligns the repo with its own README.
2. Fix E-3: wrap evaluate-and-authorize in a serializable `$transaction` with a locked per-agent daily-spend counter. Prove it with a concurrency test.
3. Fix D-3: hash over a single authoritative timestamp written by the application, add a monotonic `sequence` column, and make chain appends transactional. Prove verification passes, then prove it fails on a mutated row.
4. Fix D-4 / the E-1 entry point: Zod schemas on every endpoint (`quantity` a positive integer with a ceiling), plus DB `CHECK` constraints. Convert money to integer paise.
5. Fix E-4: authenticate `/approve` and `/deny`; make approvals single-use, expiring, and bound to an approver identity distinct from the agent.
6. Fix E-2: implement real Razorpay test-mode order creation + signature verification + a webhook with replay protection. If a live provider is unreachable in this environment, implement a **cryptographically verified mock provider that exercises the identical signature-checking code path**, and label it plainly — never a stub that simply returns success.

**P1 — required for credibility under questioning**

7. Fix E-1: mandatory agent HMAC signing on every mutating route, enforced by a Fastify `preHandler` hook rather than optional headers. Seed real signing secrets.
8. Fix D-1: replace the hand-rolled MCP server with `@modelcontextprotocol/sdk`, correct the `/api` prefix, add an `evaluate` tool, and derive `agentId` from a credential rather than a model-chosen argument.
9. Fix D-2 so the dashboard flow works end to end.
10. Fix E-5 / E-6 / E-7: remove `NEXT_PUBLIC_ADMIN_KEY`, authenticate the demo endpoints, and scope every query by merchant.
11. Enforce the state machine on *every* transition; delete the double-update pairs.
12. Write the 10 invariant tests plus an adversarial HTTP suite.

**P2 — polish**

13. Rate limiting, log redaction, `/ready`, indexes, service-layer extraction, transaction timeline UI, and replace `simulate-attack` with a **real** attack console that issues genuine requests and displays the genuine refusals.
14. Untrack `dev.db`; fix the `.gitignore` anchor. Write `docs/`.

---

## Appendix — reproduction commands

All findings marked [VERIFIED] were reproduced with the API running on `:3001` against the seeded DB (`maxTxn ₹500 / daily ₹2,000 / 5 per day / approval > ₹400`).

```bash
# D-2: the dashboard's exact request
curl -X POST localhost:3001/api/purchase-intents/$ID/evaluate \
     -H 'Content-Type: application/json' -d '{}'
# → 400 "Request integrity check failed"

# E-1: omit X-Request-ID → replay + signature checks both skipped
curl -X POST localhost:3001/api/purchase-intents/$ID/evaluate \
     -H "X-Timestamp: $(date +%s000)" -d '{}'          # → AUTHORIZED

# E-2: forge payment completion
curl -X POST localhost:3001/api/purchase-intents/$ID/complete \
     -H 'Content-Type: application/json' \
     -d '{"providerPaymentId":"pay_ATTACKER_NEVER_PAID"}'
# → 200 COMPLETED

# E-4: approve with no credentials
curl -X POST localhost:3001/api/purchase-intents/$ID/approve \
     -H 'Content-Type: application/json' -d '{"approvedBy":"the-agent-itself"}'
# → 200 AUTHORIZED

# E-6: erase security state, unauthenticated
curl -X POST localhost:3001/api/demo/reset -d '{"agentId":"agent_shopping_01"}'   # → 200

# D-4: negative quantity
curl -X POST localhost:3001/api/purchase-intents -H 'Content-Type: application/json' \
     -d '{"agentId":"agent_shopping_01","productId":"prod_usb_cable","quantity":-20,"agentReason":"x"}'
# → amount -5980, then evaluate → ALLOW

# E-3: fire 8 concurrent evaluates of Rs.399 → 6 ALLOW, Rs.2394 authorized vs a Rs.2000 cap
# D-3: curl localhost:3001/api/audit/verify → valid:false on an untouched DB
```
