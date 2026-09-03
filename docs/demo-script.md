# Demo Script

A seven-minute walkthrough. Timings assume you have already run `npm run setup` and
`npm run dev`, and that the dashboard is open at <http://localhost:3000>.

---

## 0:00 — The question (30s)

> "AI agents can already browse a catalogue, pick a product, and call a payment API.
> So here is the question nobody has a good answer to: **when an agent spends money,
> who decided that was allowed?**
>
> In most integrations today, the answer is the model — the guardrails live in a
> prompt. That means the security boundary is natural language, and natural language
> is exactly what an attacker controls."

## 0:30 — The idea (30s)

> "AgentBridge splits the two things people conflate. The agent *proposes*.
> AgentBridge *decides*. There is no language model anywhere in the decision path —
> it is a deterministic policy engine, and the decision is enforced by the database,
> not by convention."

Show the architecture section of the README, or the diagram.

## 1:00 — A normal purchase (60s)

Sign in as `owner@techkart.demo`. Go to **Attack console**, click **Run all
scenarios**, then switch to **Transactions** while it runs.

Open the ₹299 USB-C Cable transaction.

> "Here is the interesting screen. This is not a log — it is the *reasoning*. Fifteen
> rules ran. You can see all fifteen, including the twelve that passed. Amount within
> the cap. Category permitted. Daily budget has room. Risk score 0.
>
> And at the bottom, the audit trail: every step hash-chained, and the chain verified."

Point at **Chain verified**.

## 2:00 — The three outcomes (45s)

Back to Transactions. Open the ₹499 Premium Case.

> "Same fourteen rules pass. This one trips the approval threshold, so instead of
> blocking, it routes to a human."

Open the ₹1,499 Power Bank.

> "This one exceeds the per-transaction cap. Blocked. Note the reason is specific —
> ₹1,499 against a ₹500 limit — not a generic denial."

Open the ₹450 Designer Watch.

> "Cheaper than the one that was allowed, and still refused — because the category
> isn't permitted. Every product in this demo is priced so exactly one rule decides
> its fate. That is deliberate: it makes the engine legible."

## 2:45 — Now attack it (2m 30s)

Back to **Attack console**. Point at the summary.

> "Fourteen scenarios, ten of them attacks. Every one is a real signed HTTP request
> through the real stack — same routes, same middleware, same database. Nothing here
> is simulated, and no outcome is pre-decided. The runner declares what it expects and
> compares that to what actually happened."

Walk four of them:

**Forged payment.**
> "The agent invents a payment id and a signature and claims the money moved. This is
> the single most important attack in agent commerce, because it is the one that
> actually pays off. 403, and the transaction ends up FAILED. Settlement requires an
> HMAC the agent cannot produce, over an order id read from our own database."

**Concurrent spending.**
> "Eight purchases fired simultaneously against a budget that fits fewer. This is the
> attack that beats almost every implementation, because the naive design reads the
> spend, decides, then writes — and there is always a window between the read and the
> write.
>
> We don't check the limit in application code. The limit *is* the WHERE clause of a
> single atomic UPDATE. The database evaluates the condition and applies the increment
> together. There is no window."

Point at the detail line showing the cap held exactly.

**Audit tampering.**
> "We edit an audit record directly in the database, bypassing the application
> entirely, then re-verify. CONTENT_HASH_MISMATCH. Then we restore it and it verifies
> again. And re-hashing the tampered event doesn't help — it just moves the break to
> the next event."

**Self-approval.**
> "The agent tries to approve its own purchase. 401. Approval needs an authenticated
> human with an approver role. Agent credentials are a different scheme and a
> different principal type — an agent literally cannot present a merchant session."

## 5:15 — The agent's view (45s)

If you have an MCP client wired up, show the tool list. Otherwise show
`docs/mcp-security.md`.

> "This is what the agent actually sees. Six tools. Notice what isn't there: no
> `execute_payment`. There is no path from the model to settlement.
>
> Two more things. The agent's identity is not a tool argument — the previous version
> of this project let the model choose which agent to be, which is the confused-deputy
> problem in its purest form. It is now a private key the model never sees.
>
> And when a purchase needs approval, the one-time token is stripped before the
> response reaches the model. Otherwise the model could approve its own purchase."

## 6:00 — Honesty (30s)

> "Two things I want to be straight about.
>
> It runs on SQLite by default, so it clones and runs with no setup. Every concurrency
> control is engine-agnostic and the tests prove the cap holds — but production means
> Postgres.
>
> And the payment provider is sandboxed. The *verification* is real Razorpay HMAC, the
> same function in both modes, fail-closed with no secret. What's simulated is the
> counterparty, not the check. I'd rather say that than let you assume otherwise."

## 6:30 — The close (30s)

> "The thing I'd point at isn't a feature. It's this."

Run `npm test`.

> "179 tests. Twenty-nine of them are security invariants — properties the system
> claims, written as executable tests against the real server. 'An agent can never
> exceed its daily limit, including under concurrency.' 'No completion without a
> verified payment.' 'Audit tampering is always detected.'
>
> I started by auditing the previous version of this project and found eight of those
> ten invariants were provably violated. The audit report is in the repo with the
> exploits reproduced. Now they're tests, and they're green.
>
> That's the difference between a system that claims to be secure and one that can
> prove it."

---

## If a judge asks

**"Why not just use an LLM to judge the policy?"**
> Because then the security boundary is prose again. The engine is a pure function:
> the same context gives the same verdict, byte for byte, forever. You cannot argue
> with it, rephrase your way around it, or get a different answer by retrying. That's
> the whole point.

**"Isn't SQLite a cop-out?"**
> It's a trade-off I made deliberately, for a demo that has to clone-and-run. The part
> that matters is that I didn't write SQLite-specific concurrency code. The reservation
> is an atomic conditional UPDATE, which is correct on both engines with no explicit
> locking and no isolation-level tuning. Swapping to Postgres is a datasource change.

**"How do you know the audit chain actually works?"**
> Because the previous version's didn't, and I can show you why. It hashed a JS clock
> read while the database wrote its own — two milliseconds apart. It reported tampering
> on a pristine database, on every event, forever. That's in the audit report. Now
> there's one authoritative timestamp, the identity fields are inside the digest, and
> there's a gapless sequence so deletion is detectable too.

**"What if the agent is fully compromised?"**
> Then it can do exactly what its passport permits, and nothing more. It can't set a
> price, name a merchant, exceed a limit, approve anything, or settle a payment. The
> blast radius of total agent compromise is a purchase the merchant already said yes
> to. That's the design goal.

**"What's the weakest part?"**
> Catalogue text goes into the model's context unsanitised, so a hostile product
> description is a second-order injection vector. It can't escalate authority — the
> model still can't set a price or approve — but I haven't solved it, and it's written
> down as T47 in the threat model rather than glossed over.
