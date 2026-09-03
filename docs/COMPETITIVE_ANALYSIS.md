# Competitive Analysis

**A note on currency.** My knowledge of this space runs to roughly mid-2026, and it is
moving fast — several of the initiatives below were announced within months of that.
Treat specifics as a snapshot to verify, not as current fact. What I am confident about
is the *shape* of the landscape and where the gap sits.

**And the claim I will not make:** "nobody does this." That would be false and any judge
who follows the space would know it. Plenty of people are building adjacent pieces. The
honest claim is narrower and more defensible — see [The actual gap](#the-actual-gap).

---

## 1. Payment networks and agent-commerce protocols

Visa, Mastercard, Stripe, Google and OpenAI have all announced work on agent payments:
tokenised agent credentials, agent-aware checkout flows, and protocols for an agent to
transact on a user's behalf (Agentic Commerce Protocol, Agent Payments Protocol, and
the card networks' equivalents).

**What they solve well:** the rails. Provisioning credentials to agents, proving a
mandate exists, settling money, chargebacks, fraud at network scale, and merchant
acceptance. This is genuinely hard and they are the right people to do it.

**What they are not:** a merchant-side policy engine. These systems answer *"is this
agent authorised to transact at all?"* They do not answer *"should THIS merchant allow
THIS agent to buy THIS category at THIS amount right now, and what is the auditable
reason?"* That policy is business logic, it is merchant-specific, and it stays on the
merchant's side of the boundary.

**Relationship:** complementary, not competitive. AgentBridge sits upstream of the
payment rail. In the current build the rail is Razorpay; the same engine would sit in
front of any of these.

---

## 2. Policy engines

Open Policy Agent (Rego), AWS Cedar, Oso, Permit.io, Casbin.

**What they solve well:** general-purpose authorization. Rich policy languages, mature
tooling, well-understood semantics.

**Where they stop short for this problem:** they evaluate a decision, and they do it
well — but they are stateless evaluators. They do not, on their own, give you:

- **Atomic budget enforcement.** A policy engine can *check* "spend + amount ≤ cap"
  against a value you hand it. It cannot make the check and the increment one atomic
  operation. That gap is exactly where the ₹2,394-against-₹2,000 breach lived, and it
  is a database problem, not a policy problem.
- **A transaction lifecycle.** Purchase intent → authorization → approval → payment →
  settlement, with legal transitions enforced.
- **A tamper-evident record** of why each decision was made.

**Honest assessment:** a serious production build might well use Cedar or OPA *as* the
rule evaluator inside AgentBridge, and keep everything else. The policy engine here is
deliberately small and hand-written because determinism and full rule-trace
explainability were the priorities, and a 15-rule fold is easier to prove correct than
a Rego integration. That is a defensible choice, not a claim of superiority.

---

## 3. Agent frameworks and MCP

MCP itself, LangChain, the various agent SDKs.

**What MCP solves:** a standard way to expose tools to a model. It is a transport and a
capability description.

**What MCP explicitly does not solve:** whether a tool call *should* be permitted. MCP
has no notion of spending limits, no identity model for the calling agent beyond what
the host provides, and no audit trail. It is a protocol, and it is right for it to stay
one.

The confused-deputy problem is a good illustration. The previous version of this
project accepted `agentId` as a *tool argument chosen by the model* — perfectly valid
MCP, and a complete authorization failure. Nothing in MCP prevents that; the fix has to
live in the layer that MCP calls into.

**Relationship:** AgentBridge is what sits behind the MCP server.

---

## 4. Agent-payment startups

Skyfire, Payman, Nekuda, and the x402 / crypto-rail approaches.

**What they solve:** giving agents a way to hold and move value, often with
per-agent wallets and spending caps. Genuinely overlapping with parts of this.

**Where the emphasis differs:** these are largely *agent-side* — the agent gets a
wallet with limits attached. AgentBridge is *merchant-side* — the merchant defines what
agents may do in their store, and enforces it regardless of what the agent's own wallet
permits.

Both matter, and they compose: an agent wallet caps total outflow; a merchant policy
caps what is acceptable at that merchant. Neither substitutes for the other. The
merchant-side view also gets you category rules, approval routing to the merchant's own
staff, and a merchant-owned audit trail — none of which an agent wallet can provide.

**Honest note:** this is the closest competitive space, and a serious investor question
would be whether merchants will adopt a separate layer or wait for their payment
provider to ship it. My answer is in the [Positioning](#positioning) section, and it is
not a slam dunk.

---

## 5. Fraud and risk platforms

Sift, Signifyd, Stripe Radar, Forter.

**What they solve well:** statistical fraud detection at scale, trained on enormous
cross-merchant data. Far better at catching genuine fraud than anything here.

**Different problem, though.** Fraud systems answer *"is this transaction likely
fraudulent?"* — a probabilistic question, answered post-hoc, tuned on outcomes.
AgentBridge answers *"is this transaction permitted?"* — a deterministic question,
answered before the fact, from an explicit policy.

The risk engine here is deliberately transparent and rule-based rather than
statistical. Not because that is more accurate — it is not — but because a merchant
needs to be able to read *why* an agent was blocked, and a score from a model does not
provide that. A mature product would use both: rules for authorization, statistics for
fraud.

---

## The actual gap

Every piece above exists and most are built by people with more resources. What is thin
is the **composition**:

| Capability | Payment rails | Policy engines | MCP | Agent wallets | Fraud platforms | AgentBridge |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Agent identity (asymmetric) | ~ | ✗ | ✗ | ~ | ✗ | ✓ |
| Per-agent permission passport | ~ | ~ | ✗ | ✓ | ✗ | ✓ |
| Deterministic, explainable policy | ✗ | ✓ | ✗ | ~ | ✗ | ✓ |
| **Atomic budget enforcement** | ~ | ✗ | ✗ | ~ | ✗ | ✓ |
| Human-in-the-loop approval | ~ | ✗ | ✗ | ~ | ✗ | ✓ |
| Server-side payment verification | ✓ | ✗ | ✗ | ~ | ✗ | ✓ |
| Tamper-evident audit chain | ~ | ✗ | ✗ | ✗ | ~ | ✓ |
| Merchant-owned policy control | ✗ | ✓ | ✗ | ✗ | ~ | ✓ |

`✓` core capability · `~` partial or adjacent · `✗` out of scope

The row I would point at is **atomic budget enforcement**, because it is the one most
often gotten wrong — including by the previous version of this very project — and
because getting it right is a database-design decision, not a feature you can bolt on
later.

---

## Positioning

AgentBridge is not a payment processor, a policy language, or a fraud model. It is the
**merchant-side authorization layer for agent commerce**: the component that decides,
enforces, and records whether a specific agent's specific proposal becomes a specific
payment.

The wager is that as agent commerce grows, merchants will want that decision to be
theirs — enforced on their own infrastructure, against their own policy, with their own
audit trail — rather than delegated entirely to a payment network or an agent's wallet.

**The honest counter-argument:** they might not. Merchants may well accept whatever
their payment provider ships, because it is one less integration. If Stripe or Razorpay
ships a good enough merchant policy layer, the standalone case weakens considerably.

Two things that survive that scenario: the layer still has to exist *somewhere*, and
being provider-agnostic is worth something to merchants who use more than one rail or
who do not want their authorization logic owned by their processor.

---

## What I would build next to strengthen the position

1. **A second payment rail** (Stripe alongside Razorpay), to demonstrate the
   provider-agnostic claim rather than assert it.
2. **Cedar or OPA as a pluggable rule backend**, so the engine composes with existing
   policy infrastructure instead of competing with it.
3. **Policy simulation** — "what would this change have blocked last week?" — which is
   a genuinely differentiated feature and falls out naturally from having reproducible,
   versioned decisions.
4. **An export path into fraud platforms**, so the deterministic layer and the
   statistical layer feed each other.
