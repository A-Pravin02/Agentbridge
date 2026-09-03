# Security Audit — Current Build

**Date:** 2026-09-03
**Scope:** the rebuilt AgentBridge (commit following the authorization-core rebuild)
**Method:** adversarial review of the new code, plus live exploitation against a
running instance. Every finding below was **reproduced empirically** before being
fixed, and each fix has a regression test.

This is a red-team review of my own work. The Phase 0 audit (`AUDIT_REPORT.md`)
covered the previous build; this one covers what replaced it.

---

## Summary

| Severity | Found | Fixed | Open |
|---|---:|---:|---:|
| Critical | 0 | 0 | 0 |
| High | 3 | 3 | 0 |
| Medium | 2 | 2 | 0 |
| Low / accepted | 5 | 0 | 5 (documented) |

All ten Phase 0 security invariants now hold and are enforced by tests. Four new
defects were introduced by the rebuild itself; all four are fixed.

**Test posture:** 184 tests, all passing **on both SQLite and a real Neon PostgreSQL
instance**. 29 invariant tests and 55 adversarial tests drive the real server over HTTP.

---

## Findings introduced by the rebuild

### N-1 — HIGH — Rate limiting was bypassable by an attacker-controlled header

**Component:** `apps/api/src/server.ts`, rate-limit `keyGenerator`

**Exploit.** The limiter was keyed on `X-Agent-Key-Id`:

```ts
keyGenerator: (req) => req.headers['x-agent-key-id'] ?? req.ip ?? 'anonymous'
```

That header is attacker-controlled, and the rate-limit hook runs *before*
authentication. Varying it produces a fresh bucket on every request.

**Reproduced:**
```
limit 5/window, 15 requests each with a NEW random key id
-> 200,200,200,200,200,200,200,200,200,200,200,200,200,200,200
ALL 200 — LIMIT BYPASSED
```

The limiter was doing nothing at all against an attacker who knew about it.

**Root cause.** I chose the key for a *fairness* property — one noisy agent should not
exhaust the budget of everyone behind the same NAT — and in doing so used unverified
input as a security-relevant partition key. Fairness reasoning applied to a
pre-authentication control.

**Fix.** Key on IP only. Per-agent rate control now happens after authentication, via
the velocity rule in the policy engine, where identity is proven rather than asserted.

**Verified:** `-> 200,200,200,200,200,429,429,...`

**Regression test:** `adversarial › rate limiting › cannot be bypassed by varying an
attacker-controlled header`

---

### N-2 — HIGH — `/api/audit/events` returned the global chain to every tenant

**Component:** `apps/api/src/routes/merchant.ts`

**Exploit.** The endpoint was authenticated but not scoped:

```ts
const events = await prisma.auditEvent.findMany({ orderBy: { sequence: 'desc' }, take: limit });
```

Any authenticated merchant user could read every other tenant's audit events —
action names, actor ids, entity ids, and metadata including amounts.

**Reproduced:**
```
merchant alpha requests /api/audit/events
-> SEES BETA'S EVENTS — CROSS-TENANT LEAK
```

**Root cause.** I scoped every *other* dashboard query by merchant and missed this one
because the audit chain is legitimately global — it has to be, or the hash linkage
would not be verifiable end to end. I conflated "the chain is global" with "the view
of the chain is global".

**Fix.** The chain stays global; the *view* is scoped. Events are addressed by
`entityId`, so the response is filtered to the entity ids the merchant owns (its
merchant id, its agents, its recent purchase intents, its policy).

**Verified:**
```
alpha sees its own data?  yes
alpha sees beta data?     no — leak closed
```

**Regression tests:** `adversarial › audit access control › never returns another
tenant's audit events` and `… still returns the tenant's own audit events` — the pair
matters, since over-filtering would be a silent regression too.

**Known limitation:** scoping uses the merchant's 500 most recent purchase intents, so
audit events for much older intents may not appear in the global listing. The
per-transaction timeline is unaffected and always complete. A `merchantId` column on
`audit_events`, included in the digest, would remove the bound; noted for the roadmap.

---

### N-5 — HIGH — Audit-chain contention failed requests and orphaned budget on PostgreSQL

**Component:** `apps/api/src/services/audit-service.ts`, `purchase-service.ts`

**Found by:** running the suite against a real PostgreSQL instance for the first time.
SQLite could not have exposed it.

**Exploit / failure.** The audit chain head is a single row advanced by
compare-and-swap, so concurrent appends contend by design and losers retry. The retry
loop used a flat 2–10 ms backoff and 8 attempts — ample when a database round trip is
microseconds, hopeless when it is ~100 ms across a network.

Under ten concurrent purchase evaluations against Neon:

```
[0] Error: CAS_CONFLICT: audit chain head advanced concurrently
[2] Error: CAS_CONFLICT: audit chain head advanced concurrently
[6] Error: CAS_CONFLICT: audit chain head advanced concurrently
[7] Error: CAS_CONFLICT: audit chain head advanced concurrently
fulfilled: 6 / 10
ledger.reservedMinor: 179400   sum(budgetHeld): 149500
RECONCILES: NO -- LEAK
```

Two distinct defects:

1. **Availability.** Four of ten requests returned HTTP 500 and their purchase intents
   were stranded in `EVALUATING`.
2. **Budget leak.** The reservation compensator covered a failed `persist()` only. A
   throw in the *closing audit append* — after persist had committed — left the
   reservation orphaned, so the ledger no longer reconciled against the intents
   actually holding budget. Not a limit breach (the ledger over-counted, which is the
   safe direction) but it silently shrinks an agent's headroom, and a ledger drifting
   out of step with decisions is how genuine over-spend begins.

**Root cause.** Both are the same mistake in different clothes: tuning and error
handling written against a local, effectively-zero-latency database, then assumed to
hold on a networked one.

**Fix.**
- Audit appends are now serialized **within the process** by a promise-chain queue.
  Essentially all contention comes from concurrent requests on the same instance, and
  a queue removes it entirely. The CAS is retained and still does the real work —
  keeping the chain correct **across instances**, where no in-process lock can help.
- Backoff is exponential with jitter (20 ms doubling to 500 ms), and the attempt budget
  is 12.
- `recordAuditEvent(input, tx)` documents that it deliberately does not retry: inside a
  caller's transaction a conflict has already poisoned it, so the caller must retry.
- Reservation compensation now covers **every** post-reservation failure path, not just
  a failed persist, and is conditional on `budgetHeld` so it cannot double-release.
- A failure to record the audit event now **rolls the reservation back and fails the
  request**. An authorization with no audit trail is precisely what this system exists
  to prevent, so serving one would be worse than refusing.

**Verified after the fix:**

```
fulfilled: 10 / 10
statuses: {"AUTHORIZED":6,"BLOCKED":4}      <- 6 = floor(Rs.2000 / Rs.299), the exact maximum
ledger.reservedMinor: 179400  sum(budgetHeld): 179400
RECONCILES: YES
```

**Regression test:** INVARIANT 2 — `HOLDS UNDER CONCURRENCY`, which now asserts ledger
reconciliation (`reservedMinor === allowed × price`) rather than an exact grant count.
Exact-count was the wrong assertion: refusing a purchase the budget could have covered
is a liveness cost, while granting one it could not is a security failure. Only the
latter is an invariant.

---

### N-3 — MEDIUM — Budget could be held for a purchase that never existed

**Component:** `apps/api/src/services/purchase-service.ts`

**Exploit.** Budget is reserved *before* the transaction that persists the decision.
If that transaction failed, the reservation was never released — silently shrinking
the agent's remaining daily headroom for a purchase that does not exist. Repeated
often enough it becomes a denial-of-service against the agent's own budget.

Low likelihood in practice (the intent is already pinned to `EVALUATING`, so a
concurrent writer cannot normally interfere), but a database error was enough.

**Root cause.** I ordered the reservation before persistence deliberately — the ledger
must be the authority, and it must decide before the state is written. But I did not
pair the reservation with a compensating release on the failure path.

**Fix.** The persisting transaction is wrapped; any failure releases the reservation
before rethrowing.

**Regression tests:** `adversarial › budget ledger integrity › never holds budget for a
purchase that does not exist` (asserts the ledger total equals the sum of intents that
still hold budget) and `… releases budget when a payment fails verification`.

---

### N-4 — MEDIUM — Demo routes were unauthenticated

**Component:** `apps/api/src/routes/index.ts`

**Exploit.** `POST /api/demo/reset` and `/api/demo/run` mutate real agent state,
including clearing a quarantine. They were open to any caller.

This is precisely finding E-6 of the Phase 0 audit — an unauthenticated endpoint that
erases security state — reintroduced in a new form. Mitigated by the config loader
refusing to boot in production with demo routes enabled, which is why this is Medium
and not High.

**Root cause.** I treated "disabled in production" as sufficient, which ignores that
development and staging environments are also worth defending, and that a
configuration mistake should not be the only thing standing between an attacker and a
quarantine reset.

**Fix.** Demo routes require a merchant session, in addition to the production guard.

**Verified:** `POST /api/demo/reset with no session -> 401`

---

## Attacks attempted that failed (working as intended)

Each was tried against the running system and refused.

| Attack | Result |
|---|---|
| Forge a payment signature | 403; payment FAILED; budget released; stock restored; incident recorded |
| Replay a valid signed request | 401 — nonce already consumed (unique index) |
| Tamper with a signed body | 401 — body digest mismatch |
| Omit the signature header | 401 — credentials are mandatory |
| Omit the nonce header | 401 — no partial-credential path |
| Sign with a different key | 401 |
| Stale / future timestamp | 401 |
| Enumerate valid key ids | Identical response for unknown key and bad signature |
| Negative, zero, fractional, NaN, string quantity | 400 at Zod; zero rows written |
| Prototype pollution via `__proto__` | 400 — strict schema strips unknown keys |
| Omit the idempotency key | 400 — mandatory |
| Reuse a key with a different body | 409 + security incident |
| 20 identical retries | Exactly one purchase created |
| Concurrent purchases racing the daily cap | Cap held exactly; 6 of 10 allowed against ₹2,000 |
| Concurrent payment orders on one intent | Exactly one succeeded |
| Buy another merchant's product | 404 — indistinguishable from nonexistent |
| Read another agent's intent | 404 |
| Approve without a session | 401 |
| Approve with agent credentials | 401 |
| Approve as another merchant's user | 404 |
| Replay an approval | 409 |
| Approve with a wrong or expired token | 403 |
| Change policy as a VIEWER | 403 |
| Forge a webhook | 403 |
| Replay a webhook | `DUPLICATE`, no side effects |
| Tamper with a webhook body after signing | 403 |
| Edit an audit record | `CONTENT_HASH_MISMATCH` |
| Rewrite an audit actor | Detected |
| Delete an audit event | Detected via sequence gap |
| Re-hash a tampered event to repair the chain | Break moves to the next event |
| Settle one payment against two transactions | 409 — unique constraint |

---

## Accepted risks

Not defects — deliberate trade-offs or genuine limits, all documented rather than
hidden.

### A-1 — Catalogue text is not sanitised before reaching the model
`search_products` returns product names and descriptions into the model's context, so
a hostile description is a second-order prompt-injection vector. Injected instructions
cannot escalate authority — the model still cannot set a price, exceed a limit, approve,
or settle — so the blast radius stays inside the merchant's own policy envelope. But
the text is not filtered. Tracked as T47 in the threat model.

### A-2 — Audit rows are deletable by the application's database user
The chain makes deletion **detectable** (sequence gap), not **impossible**. Closing it
properly needs append-only storage or an external anchor for the head hash. For a
single-operator tamper-evidence requirement, detection is the right level; claiming
more would be dishonest.

### A-3 — Rate limiting does not survive horizontal scaling
The limiter is in-process. Behind multiple replicas the effective limit multiplies by
the replica count. A shared store is on the deployment checklist.

### A-4 — SQLite by default
Correct under every concurrency test, and the controls are engine-agnostic by
construction, but it is a single-writer engine. Production means PostgreSQL.

### A-5 — One dependency advisory
`deepmerge-ts` (stack exhaustion on recursive graphs), reached only through the Prisma
CLI, a dev dependency. Not in the runtime path. Fixed only in a Prisma 8 release
candidate; shipping an RC of the ORM to resolve a dev-only advisory is the worse
trade. Re-evaluate when Prisma 8 is stable.

Enforced rather than merely asserted: `scripts/audit-check.mjs` fails CI on any high or
critical advisory that is **not** on an explicit accepted list. This one is listed with
its reason; anything new breaks the build. The blunter `npm audit --omit=dev` was tried
first and does not work here — it fails to exclude a *workspace* package's
devDependencies, so it flagged this advisory and failed the build on a package that
never ships.

---

## Design decisions worth defending

Points a reviewer might challenge, with the reasoning.

**Why Ed25519 rather than HMAC for agents?** HMAC requires the verifier to hold a
secret that can also sign, so a database compromise, backup leak, or curious operator
can impersonate any agent. With Ed25519 the server stores only public keys. There is
no secret at rest capable of impersonating an agent.

**Why is the daily limit not checked in application code?** Because a check and a
write are two operations, and there is always a window between them. Two concurrent
requests read the same pre-state and both pass — which is exactly how the previous
build authorized ₹2,394 against a ₹2,000 cap. Making the limit the predicate of a
single atomic `UPDATE` removes the window rather than narrowing it.

**Why does the policy engine also check the daily limit, if the ledger enforces it?**
For explanation. The engine produces the human-readable reason and the rule trace; the
ledger produces the guarantee. When they disagree — because a concurrent request landed
in between — the ledger wins and the verdict is downgraded to BLOCK.

**Why 404 instead of 403 for cross-tenant access?** A 403 confirms the resource exists.
Returning 404 makes "not yours" indistinguishable from "not there", so the API cannot
be used to enumerate another merchant's catalogue or intents.

**Why is the webhook endpoint unauthenticated?** Because the HMAC over the raw body
*is* the authentication, and it is stronger than a bearer token would be — it
authenticates the payload, not merely the caller. It is also the settlement path that
still works when a customer closes the browser before being redirected back.

**Why does the sandbox provider hold the key secret?** So it can mint a *valid*
signature for the happy path while attack scenarios pass signatures it never minted.
Without that, "forged payment is rejected" would be untestable — everything would fail,
including the legitimate case, and the test would prove nothing.

---

## Verdict

The current build has no known critical or high-severity vulnerabilities. The five
defects the rebuild introduced were found by adversarial review of my own code and by
running the suite on a second database engine. Each was reproduced before being fixed,
and each carries a regression test.

N-5 is worth singling out. It was invisible on SQLite and appeared immediately on
PostgreSQL, which is the argument for testing against the engine you actually deploy
rather than the one that is convenient.

The property I would put weight on is not the absence of findings — it is that the
system's security claims are executable. Ten invariants, written as tests against the
real server. If any of them regresses, CI goes red and the claim is falsified
automatically.

The Phase 0 audit found eight of those ten provably violated. They now hold.
