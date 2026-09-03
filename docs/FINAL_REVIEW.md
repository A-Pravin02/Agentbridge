# Final Review

A self-assessment of the finished build. Scores are 1–10 and are meant to be useful,
not flattering — an all-9s scorecard would tell you nothing.

Reference points: 5 = a competent hackathon submission. 7 = notably strong. 9 = would
survive a serious production review in that dimension.

---

## Scorecard

| Dimension | Score | Reasoning |
|---|:--:|---|
| **Problem** | 9 | Real, current, and sharpening. Agents can already call payment APIs; the authorization layer genuinely does not exist in most integrations. Not a manufactured problem. |
| **Novelty** | 7 | The composition is novel and the atomic-ledger framing is not the obvious approach. But policy engines, agent wallets and payment rails all exist — this is a good synthesis, not a new primitive. |
| **Technical depth** | 9 | Atomic CAS concurrency control, Ed25519 request signing, hash-chained audit with gapless sequencing, CAS chain head, real HMAC settlement. Each choice has a reason that survives questioning. |
| **AI integration** | 7 | MCP done properly: identity is not a tool argument, no payment primitive, approval token stripped from model context. Loses points because the AI surface is deliberately thin — correct, but less to show than a flashier agent demo. |
| **Security** | 9 | 29 invariant tests, 55 adversarial tests, two published audits including one against my own rebuild. Not 10: catalogue text is unsanitised (T47), audit rows are deletable-but-detectable, rate limiting is single-instance. |
| **Backend** | 9 | Clean layering, pure decision logic, transaction boundaries everywhere, typed errors, fail-closed defaults. Would pass a senior review. |
| **Database** | 8 | Integer money with CHECK constraints, proper uniqueness as enforcement, sensible indexes, immutable policy snapshots. Held back by SQLite as default and the missing `merchantId` on audit events. |
| **Payment integration** | 6 | The verification code is real and correct — same function in both modes, fail-closed. But the counterparty is sandboxed and live Razorpay keys were never exercised end to end. This is the honest score. |
| **Agent architecture** | 8 | The permission passport, effective-limit composition, and quarantine escalation are well modelled. Single agent type; no delegation or sub-agent hierarchy. |
| **MCP** | 8 | Official SDK, local Zod validation, credential-holding process, deliberate tool surface. Not 9 because it is one server with six tools and no resource/prompt surface. |
| **UX** | 7 | The transaction timeline is genuinely the right screen, and the attack console is legible. But it is one dark dashboard, thin on empty states, and approval requires pasting a token by hand. |
| **Demo** | 9 | Fourteen real scenarios through the real stack with declared expectations. Reruns cleanly, isolates state, and turns red on regression. The strongest demo asset is that it can fail. |
| **Testing** | 9 | 184 tests where the security-critical paths are the *most* covered, not the least. Invariants map one-to-one onto claims. CI now gates them. Missing: property-based testing, and the workflow has not yet run on a real runner. |
| **Documentation** | 9 | Twelve documents including two adversarial audits with reproduction commands. Limitations sections are real. Slightly over-long in places. |
| **Scalability** | 6 | Still the weak spot: in-process rate limiting, audit appends serialize on one chain head, no queue. Up one point because the concurrency invariants are now *verified* on PostgreSQL rather than assumed, and the append path was hardened for network latency in the process. |
| **Business potential** | 6 | Plausible infrastructure thesis with a clear wedge — and a genuinely threatening counter-case (payment providers absorbing it) that I have not resolved. |
| **Production readiness** | 6 | Up from 2 at audit time. Real auth, real constraints, real verification, health/readiness endpoints. Not higher: SQLite, no key rotation, no shared rate-limit store, unexercised live payments, no deployed instance. |

**Mean: 7.8** · **Security-weighted mean: 8.4**

---

## 1. What would a senior engineer criticize?

- **"Your audit appends serialize on a single row."** Correct, and deliberate — a
  globally ordered verifiable log was worth more than append throughput here. But it is
  a hard ceiling and I should say so before being asked.
- **"`purchase-service.ts` is doing a lot."** The evaluate path is ~180 lines spanning
  threat analysis, policy, ledger, quarantine and persistence. It is coherent and
  commented, but it is the file that would fight back hardest under change.
- **"Your CI has never run."** A workflow now exists and gates typecheck, the full
  suite and the build on every push — but it has not executed on a real runner, so
  treat it as configured rather than proven.
- **"Prisma's `updateMany` as a concurrency primitive is clever but implicit."** A raw
  SQL statement with an explicit comment might be more honest about what it relies on.
- **"You reset agent state between tests."** Justified in comments — the controls
  genuinely compose and would otherwise mask each other — but it is the kind of thing
  that hides real coupling if you stop reading.

## 2. What would a security engineer criticize?

- **"Catalogue text reaches the model unsanitised."** The sharpest remaining hole.
  Bounded — it cannot escalate authority — but unsolved (T47).
- **"Detectable is not immutable."** Audit rows are deletable by the app's own DB user.
  I claim tamper-evidence and only tamper-evidence, but a reviewer will want
  append-only storage or an external anchor.
- **"Your rate limiter died the moment you scaled."** True. In-process only.
- **"No key rotation."** An agent key compromise has no clean recovery path.
- **"You introduced four vulnerabilities in the rebuild."** Fair. My defence is that I
  found them by red-teaming my own code, reproduced each before fixing, and published
  them — but a reviewer is right to note that the rate-limiter bug in particular was a
  basic error: I used unverified input as a security partition key.
- **"The approval token flows through the agent."** The agent receives it and a human
  pastes it. Defensible (it proves the approval is bound to a specific evaluation) but
  an out-of-band delivery channel would be stronger.

## 3. What would a hackathon judge criticize?

- **"SQLite, when your README says PostgreSQL is the target."** The reasoning is sound
  and documented, but it reads as a shortcut at first glance.
- **"Payments aren't really live."** The single most likely challenge. The verification
  is real; the counterparty is not, and no amount of explanation fully removes that.
- **"The AI part is thin."** Six MCP tools and no agent reasoning on display. That is
  the *correct* design — the whole thesis is that the model should have less authority —
  but it makes for a less dazzling demo than a chatty agent.
- **"This is mostly backend."** Yes. The frontend exists to make the backend legible.
- **"Where's the deployed instance?"** Runs locally only.

## 4. What would an investor criticize?

- **"What stops Stripe shipping this next quarter?"** The strongest objection, and I do
  not have a fully satisfying answer. Provider-agnosticism and compliance depth are the
  mitigations; neither is a moat.
- **"Is the market here yet?"** Agent commerce volume today may not support a dedicated
  authorization vendor.
- **"Your moat is open-source code."** The defensible asset is the accumulated audit
  record and correctness reputation, not the engine.
- **"No customers, no validation."** Zero conversations with real merchants. The
  business model doc is reasoning, not evidence.
- **"Being in the revenue critical path is unforgiving."** Correct, and this build is
  nowhere near that operational bar.

## 5. The single biggest weakness

**Operational maturity under load.**

The concurrency controls are now verified on PostgreSQL, which removes the sharpest
form of this criticism. What remains is real: rate limiting does not survive
horizontal scaling, and audit appends serialize on a single chain head — a deliberate
trade for a globally ordered verifiable log, but a hard throughput ceiling.

The runner-up is the sandboxed payment counterparty, which is the more *likely* thing
to be challenged even though it is the less serious problem.

## 6. The single strongest feature

**The executable security invariants.**

Ten properties the system claims, written as tests that drive the real server over
HTTP. Eight of the ten were provably violated in the previous build — with working
exploits in `AUDIT_REPORT.md` — and they now hold.

That is not "we take security seriously." It is a falsifiable claim with a command that
checks it. Everything else in the project is downstream of that discipline: the atomic
ledger exists because invariant 2 has to pass, the HMAC gate exists because invariant 4
has to pass.

## 7. What should NOT be changed

- **The atomic budget ledger.** It is the correct solution to the hardest problem here.
  Do not "simplify" it back into a read-check-write.
- **Pure, I/O-free decision logic.** The reason the policy engine is testable and
  reproducible at all.
- **No LLM in the decision path.** The entire thesis. Non-negotiable.
- **The invariant suite.** If a change makes an invariant fail, the change is wrong.
- **Server-authoritative pricing.** Structurally correct; do not add an amount field.
- **404-not-403 for cross-tenant access.** Deliberate anti-enumeration.
- **The honesty of the limitations sections.** Removing them would make the project
  weaker, not stronger.

## 8. What should be improved before submission

In priority order, with realistic effort:

1. ~~Add CI~~ — **done.** `.github/workflows/verify.yml` gates typecheck, tests and
   build on every push. Still needs one real run on a runner to confirm it is green.
2. ~~Run the suite against PostgreSQL once~~ — **done.** 184/184 against Neon. It
   found a real bug SQLite could not (see N-5 in SECURITY_AUDIT.md).
3. **Formerly item 2:** (~2h) and put the result in the README.
   Converts "the design is engine-agnostic" from an assertion into evidence, and
   directly answers the biggest criticism.
3. **Sanitise catalogue text** before it reaches the model (~2h). Closes T47, the
   sharpest open security gap.
4. **Deploy a live instance** (~2h). Removes "where can I try it?" entirely.
5. **Record a 3-minute demo video** (~1h). Insurance against a live-demo failure.
6. **Add `merchantId` to audit events** (~1h) and remove the 500-intent scoping bound.
7. *If time remains:* exercise real Razorpay test keys end to end. Highest credibility
   value, highest risk of eating the remaining time.

Items 2 and 3 are the ones I would not submit without.

---

## Closing assessment

**As a hackathon project: strong.** The demo is memorable specifically because it can
fail, the security work is unusually deep for the format, and the audit trail from
"eight invariants broken" to "eight invariants tested and green" is a story with
evidence behind it.

**As production infrastructure: not yet.** Roughly a 6/10, up from 2/10 at audit time.
The architecture would survive; the deployment posture would not.

**The thing I would want judged** is not any single feature. It is that every security
claim in this repository is attached to a command that checks it, and that the two
audits — including the one against my own rebuild — publish the failures rather than
the successes.
