# Business Model

Written as an evaluation of AgentBridge *as infrastructure*, not as a feature list. The
brief was explicit that business thinking must not damage the MVP, so nothing in this
document has been built — this is analysis of what the thing could become, kept
deliberately separate from what it is.

---

## The thesis in one paragraph

Agent commerce is arriving on rails built by payment networks and model providers.
Those rails answer *"may this agent transact?"* Nobody's rail answers *"should THIS
merchant permit THIS agent to buy THIS, right now, and what is the auditable reason?"*
That question is merchant-specific business logic with hard correctness requirements —
atomic limits, cryptographic settlement, tamper-evident records — and it is
uncomfortable to build correctly. That combination (necessary, non-differentiating,
easy to get subtly wrong) is what infrastructure businesses are made of.

---

## Who has this problem

Ordered by how acutely they feel it today.

**1. Merchants exposing an agent-accessible catalogue.**
The moment a merchant lets agents buy, they need per-agent limits and an audit trail.
Highest urgency, largest number, lowest willingness to pay individually.

**2. AI commerce platforms and autonomous shopping agents.**
They must convince merchants and users that their agent is safe to give money to.
"Our authorization layer is independently verifiable" is a sales asset for them.

**3. Enterprise AI platforms with procurement agents.**
An agent that buys cloud capacity, software seats, or supplies. Spending controls are
not optional here — they are a finance and compliance requirement, with an existing
budget line.

**4. Fintechs and PSPs.**
Would more likely build or acquire than buy. A partnership or licensing target rather
than a customer.

**5. Marketplaces with third-party agents.**
Need per-agent policy and isolation across many principals. Structurally the best fit
for the multi-tenant model already in the schema, but a later market.

The wedge I would pick is **(3)**, because enterprise procurement has a named buyer, an
existing budget, and a compliance requirement that makes an audit trail a purchase
justification rather than a nice-to-have.

---

## What could be sold

Only the first two are close to what exists today. The rest are honestly labelled as
future.

| Product | Status | Note |
|---|---|---|
| **Authorization API** — policy evaluation, limits, approvals, audit | Core of the current build | The product |
| **Agent identity** — key issuance, rotation, revocation | Partially built (Ed25519 identity exists; no rotation flow) | Natural adjacency |
| **Audit & compliance export** — verifiable decision records | Chain exists; export/attestation does not | Where regulated buyers pay |
| **Policy simulation** — "what would this change have blocked?" | Not built | Falls out of reproducible decisions; genuinely differentiated |
| **Risk scoring** | Heuristic version built | Weakest standalone claim — fraud vendors are better |
| **Agent wallets / spend management** | Not built | Adjacent, and a crowded space |

---

## How it would be priced

Infrastructure priced on the unit the customer already counts.

- **Per authorization decision**, tiered — the natural metric, and it scales with the
  customer's own growth.
- **Platform fee** for the control plane, dashboards, retention, and support.
- **Not** a percentage of transaction value. That is payment-processor pricing, and
  charging it without carrying settlement risk invites the obvious question of why.

A defensible free tier matters here: developers must be able to build against it before
anyone signs anything.

---

## Why this could be a business rather than a feature

1. **Correctness is the product.** The atomic-ledger and audit-chain problems are easy
   to implement subtly wrongly — as the Phase 0 audit of this project's own earlier
   build demonstrates in detail. A vendor whose entire job is getting that right, with
   executable invariants proving it, is a rational buy versus a build.
2. **It is non-differentiating for the buyer.** No merchant wins on having written
   their own agent authorization layer.
3. **Audit trails create switching costs** in the good way — the historical record
   lives with the vendor, and compliance value accrues over time.
4. **It sits at a boundary that is only widening** as agent commerce grows.

## Why it might not

Stated plainly, because the counter-case is real.

1. **Payment providers may absorb it.** If Stripe or Razorpay ships a good-enough
   merchant policy layer, the standalone case weakens sharply. This is the single
   biggest risk.
2. **Merchants may not adopt a separate layer.** One more integration, one more vendor,
   one more thing in the critical path of revenue.
3. **The market may be early.** Agent commerce volume today may not support a
   dedicated authorization vendor yet.
4. **Being in the critical path is brutal.** Downtime blocks revenue. That demands an
   operational maturity far beyond a hackathon build, and it is a real barrier to
   first customers.

Honest read: **(1) is the one that would actually kill it.** The mitigations are being
provider-agnostic from day one and going deeper on the compliance/audit side than a
payment processor would bother to.

---

## Where the moat would be, if there is one

Not the policy engine — that is a weekend's work for a competent team, and the code is
open.

More plausibly:

- **The audit and compliance record.** Verifiable decision history accumulates value
  and is painful to migrate away from.
- **Correctness reputation.** In a category where the failure mode is "money moved
  wrongly," a published audit trail and a public invariant suite are a genuine
  commercial asset. That is unusual, and it is the one this project actually has.
- **Provider-agnosticism.** Valuable precisely to the merchants a single processor
  cannot serve.

---

## What I would validate before writing more code

In order, cheapest first:

1. **Do merchants actually want to own this decision,** or are they content to let
   their processor make it? Ten conversations would answer it.
2. **Is the enterprise procurement wedge real** — does an existing budget line cover
   "agent spending controls"?
3. **What is the realistic decision volume** for an agent-commerce merchant today? This
   determines whether per-decision pricing is a business or a rounding error.
4. **Would a payment provider partner or compete?** The answer changes the strategy
   entirely.

Only after those would a hosted control plane, billing, or multi-region be worth
building.

---

## Relationship to the current build

Nothing above has been implemented, and deliberately so. The repository is a
technically complete demonstration of the authorization layer — not a product with
billing, onboarding or a hosted plane bolted on.

The one place business thinking already shows in the code is the multi-tenant schema:
merchants, merchant users, roles, and per-tenant scoping exist because tenant isolation
is a *security* requirement, and it happens also to be the foundation a multi-customer
product would need. That was the correct order to do it in.
