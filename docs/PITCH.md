# AgentBridge

## The question

**AI agents are becoming capable of spending money. Who decides what they are allowed to spend?**

Right now, in most integrations, the answer is: the model.

That is not a hypothetical. An agent with a payment API key and a system prompt saying
"don't spend more than ₹500" has exactly one thing standing between it and your bank
account — a sentence in a prompt. And a prompt is the one part of the system an
attacker can rewrite by leaving instructions in a product description.

## The problem with the obvious architecture

```
AI Agent ──────────────────────────────► Payment API
```

Simple, and it ships. But it means the agent *holds financial authority*. Every
guardrail lives inside the thing being guarded.

Three failure modes follow, and they are not exotic:

1. **Prompt injection becomes a purchase.** The security boundary is natural
   language, which is precisely what an attacker controls.
2. **The agent reports its own success.** "Payment completed" is a claim from an
   untrusted client, and most integrations believe it.
3. **Limits are checked, not enforced.** Read the spend, compare, write. Two
   concurrent requests both pass. The limit was never real.

That third one is the quiet killer, because the code looks correct.

## The insight

The failure is not that the policy was wrong. It is that **the policy was never
enforced by anything that couldn't be raced, argued with, or skipped.**

So:

> **LLMs propose actions. AgentBridge enforces authorization.**

The agent submits a *proposal*. A deterministic policy engine — no model anywhere in
the decision path — returns ALLOW, REQUIRE_APPROVAL or BLOCK. And that verdict is
backed by database constraints, atomic writes and cryptographic signatures, not by
application if-statements.

## The architecture

```
AI Agent → MCP tools → AgentBridge ─┬─ Ed25519 identity        who is asking?
                                    ├─ Permission passport     what may it do?
                                    ├─ Deterministic policy    is this allowed?
                                    ├─ Behavioural risk        is this normal?
                                    ├─ Atomic budget ledger    is there room?
                                    ├─ Human approval          does someone agree?
                                    ├─ Payment verification    did money move?
                                    └─ Hash-chained audit      what happened?
                                                │
                                                ▼
                                          Payment provider
```

## Three design decisions worth the whole pitch

**1. The spending limit is a WHERE clause, not an if-statement.**

Every naive implementation reads the spend, decides, then writes — and there is always
a window between the read and the write. We made the limit the predicate of a single
atomic `UPDATE`, so the database evaluates the condition and applies the increment
together, under a lock it takes itself. There is no window.

*Ten concurrent purchases against a ₹2,000 cap: exactly six allowed, ₹1,794 reserved.*

**2. The server holds nothing that can impersonate an agent.**

Agent identity is Ed25519, not a shared secret. The obvious design — HMAC per agent —
requires the verifier to hold a key that can also sign, so a database leak means
impersonation. We store only public keys. There is no secret at rest capable of
forging an agent request.

**3. There is no path from the model to settlement.**

The MCP tool surface has six tools and no `execute_payment`. Completion requires an
HMAC over an order id read from our own database. The agent can get a purchase
*authorized*; it cannot make money move.

## The demo

Open the dashboard, click **Run all scenarios**. Fourteen scenarios execute as real
signed HTTP requests through the real stack — same routes, same middleware, same
database. Ten are attacks.

```
scenarios passed : 14/14
attacks stopped  : 10/10
```

Forged payment. Replayed request. Tampered body. Omitted signature. Negative quantity.
Concurrent spending. Audit tampering. Cross-tenant access. Self-approval. Repeated
attacks triggering automatic quarantine.

Nothing is simulated. Each scenario declares what it expects and the runner compares
that to what actually happened — so a regression turns the demo red.

## What makes this credible rather than impressive-looking

I started by auditing the previous version of this project and **found that eight of
its ten security invariants were provably violated.** Not suspected — reproduced, with
working exploits, against a running instance:

- 8 concurrent requests authorized **₹2,394 against a ₹2,000/day cap**
- `POST /complete` with `"pay_ATTACKER_NEVER_PAID"` marked a transaction **COMPLETED**
- The audit chain reported **TAMPER_DETECTED on an untouched database** — it had never
  verified successfully, because it hashed a JS clock read while the database wrote its
  own, two milliseconds apart
- An unauthenticated POST **approved any pending purchase**
- `quantity: -20` was **ALLOWED** and inflated the daily budget by ₹5,980

That audit is in the repo (`AUDIT_REPORT.md`) with reproduction commands.

Those ten invariants are now **executable tests against the real server**. If any one
regresses, CI goes red and the claim is falsified automatically. That is the difference
between a system that claims to be secure and one that can prove it.

**184 tests. 29 invariants. 55 adversarial cases.**

I then red-teamed my own rebuild and found four more defects I had introduced —
including a rate limiter keyed on an attacker-controlled header that was doing nothing
at all. All four are fixed, each with a regression test, and all four are written up in
`SECURITY_AUDIT.md` rather than quietly patched.

## What I will not claim

- It runs on SQLite by default. Correct under every concurrency test, and the controls
  are engine-agnostic by construction — but production means PostgreSQL.
- The payment provider is sandboxed. The *verification* is real Razorpay HMAC, the same
  function in both modes, fail-closed without a secret. What is simulated is the
  counterparty, not the check.
- Catalogue text reaches the model unsanitised, so a hostile product description is a
  second-order injection vector. It cannot escalate authority — the model still cannot
  set a price or approve — but it is unsolved, and it is written down as T47 in the
  threat model.

## Why this matters beyond a demo

Agent commerce is arriving whether or not the authorization layer exists. The payment
networks are building agent rails; the model providers are building agent commerce
protocols. What is thin is the layer in between — the part that says *this specific
agent, acting for this specific user, may spend this much, here, now, and here is the
cryptographic record of why.*

That is not a feature of a payment processor. It is infrastructure, and it belongs
between the agent and the money.

## The one line

> **An LLM can recommend a purchase. It should never be the thing that authorizes one.**
