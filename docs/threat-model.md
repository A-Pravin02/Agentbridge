# Threat Model

**Core assumption: the AI agent is untrusted.** Not "probably fine" — untrusted, in
the same sense a browser client is untrusted. It may be prompt-injected, jailbroken,
buggy, or fully attacker-controlled. Every control below is designed on the assumption
that the agent is trying to defeat it.

Secondary assumptions:

- The frontend may be compromised or replaced.
- Requests may be replayed, reordered, or issued concurrently.
- The attacker knows the API surface and reads this document.
- Merchants may misconfigure their own policies.
- Payment responses may be forged.

The only things trusted are: the server's own database reads, the server's clock
(within a bounded skew), and secrets held server-side.

**Legend.** L/M/H = likelihood. Test = the automated test that proves the mitigation,
so every claim here is falsifiable by running `npm test`.

---

## 1. Agent identity and request integrity

### T1 — Prompt injection turns into a purchase
- **Surface:** any untrusted text reaching the model — product descriptions, web content, user input.
- **Impact:** High. Attacker-chosen purchases.
- **Likelihood:** H. This is the defining risk of agent commerce.
- **Mitigation:** Injection can only ever produce a *proposal*. The model cannot set price (server-resolved), cannot set the merchant (derived from the product), cannot exceed limits (policy engine + ledger), and cannot approve (needs a human session). The blast radius of a successful injection is "a purchase that satisfies the merchant's own policy" — which is the intended envelope.
- **Test:** the whole invariant suite; specifically INVARIANT 7 (price authority).

### T2 — Agent impersonation
- **Surface:** `POST /api/*` with a forged identity.
- **Impact:** Critical. Spend as someone else.
- **Likelihood:** H if identity is asserted rather than proved.
- **Mitigation:** Ed25519 signature over a canonical request string. The server stores only public keys, so a full database compromise still cannot forge an agent request.
- **Test:** `adversarial › rejects a signature made with the wrong private key`.

### T3 — Stolen agent credentials
- **Surface:** a leaked private key.
- **Impact:** High — but bounded by that agent's passport, daily cap and category list.
- **Likelihood:** M.
- **Mitigation:** Damage is capped by the permission passport, not unlimited. Behavioural analysis flags anomalous use; escalation quarantines automatically. Keys are per-agent, so one compromise does not affect others.
- **Test:** `adversarial › escalation › quarantines an agent after repeated severe violations`.
- **Gap:** no rotation endpoint yet (see README limitations).

### T4 — Replay attack
- **Surface:** capturing and resending a valid signed request.
- **Impact:** High. Duplicate purchases.
- **Likelihood:** H.
- **Mitigation:** Every signed request carries a nonce, consumed via a `@@unique([agentId, requestId])` index — single-use is a database guarantee, not a checked-then-used race. A ±5 minute timestamp window bounds the attack surface independently.
- **Test:** `adversarial › rejects a replayed nonce even with a valid signature`.

### T5 — Signature stripping
- **Surface:** omitting the signature header.
- **Impact:** Critical — total auth bypass.
- **Likelihood:** H. **This was a real, exploited flaw in the previous build** (see AUDIT_REPORT E-1).
- **Mitigation:** All four credential headers are mandatory. A missing header is a failure, never a skip. The check is a route `preHandler`, not an inline conditional.
- **Test:** `adversarial › rejects a request missing ONLY the signature header`, `… ONLY the nonce header`.

### T6 — Request tampering after signing
- **Surface:** modifying the body in transit.
- **Impact:** High. Change the quantity or the product.
- **Likelihood:** M.
- **Mitigation:** The signature covers a SHA-256 of the raw body bytes, plus method, path, nonce and timestamp — so a signature cannot be lifted onto another route or reused after any edit.
- **Test:** `adversarial › rejects a body altered after signing`.

### T7 — Clock skew / expired request abuse
- **Surface:** forged timestamps.
- **Impact:** Medium.
- **Likelihood:** M.
- **Mitigation:** ±5 minutes, enforced in both directions.
- **Test:** `adversarial › rejects a stale timestamp`, `… far-future timestamp`.

### T8 — Key enumeration oracle
- **Surface:** probing key ids to discover valid agents.
- **Impact:** Low-Medium. Reconnaissance.
- **Likelihood:** M.
- **Mitigation:** Unknown key and bad signature return the identical status and message.
- **Test:** `adversarial › rejects an unknown key id indistinguishably from a bad signature`.

---

## 2. Money and policy

### T9 — Amount manipulation
- **Surface:** a client-supplied price or amount.
- **Impact:** Critical.
- **Likelihood:** H.
- **Mitigation:** Structurally impossible. No endpoint accepts an amount. `amountMinor = product.priceMinor × quantity`, computed server-side; the strict Zod schema rejects an `amountMinor` field outright.
- **Test:** INVARIANT 7 — `ignores any client-supplied amount field`.

### T10 — Negative or fractional quantity
- **Surface:** `quantity: -20`.
- **Impact:** Critical. **Was exploitable**: produced a negative amount that was ALLOWED and inflated the daily budget by ₹5,980 (AUDIT_REPORT D-4).
- **Likelihood:** H.
- **Mitigation:** Three layers. Zod (`int().min(1).max(1000)`), `multiplyMinor` (throws on non-positive), and a database `CHECK ("quantity" >= 1)`.
- **Test:** INVARIANT 7 — `rejects a negative quantity and stores nothing`; 11 validation cases in the adversarial suite.

### T11 — Stale price (TOCTOU on the catalogue)
- **Surface:** creating an intent, then the merchant changes the price.
- **Impact:** Medium.
- **Likelihood:** M.
- **Mitigation:** The amount is re-derived from the current product price at evaluation time; the stale amount is not honoured.
- **Test:** INVARIANT 7 — `re-derives the amount at evaluation if the catalogue price changed`.

### T12 — Currency manipulation
- **Surface:** requesting a cheaper currency.
- **Impact:** High.
- **Likelihood:** L.
- **Mitigation:** Currency comes from the product record, and must appear in both the merchant's and the agent's allow-lists.
- **Test:** `policy-engine › blocks a currency neither side permits`.

### T13 — Spending-limit bypass by concurrency
- **Surface:** simultaneous requests that each individually pass the check.
- **Impact:** Critical. **Was exploitable**: 8 concurrent requests authorized ₹2,394 against a ₹2,000 cap (AUDIT_REPORT E-3).
- **Likelihood:** H — trivial to attempt.
- **Mitigation:** The limit is not checked in application code. It is the predicate of a single atomic `UPDATE` on the daily ledger, so the database evaluates the condition and applies the increment together under its own row lock. There is no window.
- **Test:** INVARIANT 2 — `HOLDS UNDER CONCURRENCY`; also the transaction-count variant.

### T14 — Transaction-count and velocity abuse
- **Impact:** Medium.
- **Mitigation:** Count cap is part of the same atomic ledger predicate; per-minute velocity is a policy rule.
- **Test:** INVARIANT 2 — `holds the transaction-count cap under concurrency`.

### T15 — Policy bypass by argument
- **Surface:** phrasing, retrying, or "explaining" to get a different answer.
- **Impact:** Critical.
- **Likelihood:** H — this is what models do.
- **Mitigation:** No LLM participates in the decision. `evaluatePolicy` is pure: same context, same verdict, byte for byte. Rephrasing changes nothing because prose is not an input.
- **Test:** `policy-engine › determinism › produces an identical result for an identical context`.

### T16 — Risk score downgrading a hard block
- **Surface:** a low risk score on an over-limit purchase.
- **Impact:** High.
- **Likelihood:** L, but a natural design mistake.
- **Mitigation:** The verdict is a fold over `mostRestrictive`. Risk can escalate ALLOW → REQUIRE_APPROVAL → BLOCK, but nothing can move a decision down.
- **Test:** `policy-engine › a low risk score can NEVER downgrade a hard policy block`.

### T17 — Stale policy decision
- **Surface:** authorization obtained, then the policy tightens.
- **Impact:** Medium.
- **Mitigation:** Authorizations expire (15 min default) and are re-checked before a payment order is created. Policy changes bump a version and snapshot the old one.
- **Test:** INVARIANT 10 — `preserves a snapshot of the old policy when it changes`.

---

## 3. Payment

### T18 — Forged payment success
- **Surface:** claiming a payment completed.
- **Impact:** Critical — goods ship, no money moves. **Was exploitable** (AUDIT_REPORT E-2).
- **Likelihood:** H.
- **Mitigation:** COMPLETED is reachable only through `settleVerified`, which is private and called only after an HMAC check passes. The order id used in the digest is read from our database, so a forged order cannot be self-consistently signed. There is no `status` field to trust anywhere.
- **Test:** INVARIANT 4 — `rejects a forged payment signature and never reaches COMPLETED`.

### T19 — Cross-order signature replay
- **Surface:** a real signature from a cheap order, reused on an expensive one.
- **Impact:** Critical.
- **Likelihood:** M.
- **Mitigation:** The digest binds order id *and* payment id together.
- **Test:** `payments › rejects a signature minted for a DIFFERENT order`.

### T20 — Double settlement
- **Surface:** one provider payment settling two transactions.
- **Impact:** High.
- **Mitigation:** `providerPaymentId` is globally unique, plus a conditional status update.
- **Test:** INVARIANT 5 — `rejects reuse of a provider payment id`.

### T21 — Webhook spoofing
- **Surface:** posting a fake `payment.captured`.
- **Impact:** Critical.
- **Likelihood:** H — the endpoint is necessarily unauthenticated.
- **Mitigation:** HMAC over the **raw** body bytes. Raw capture matters: re-serializing parsed JSON changes the digest and would make the check meaningless.
- **Test:** `adversarial › rejects an unsigned webhook`, `… body altered after signing`; `payments › is sensitive to whitespace`.

### T22 — Webhook replay
- **Impact:** High.
- **Mitigation:** `@@unique([provider, providerEventId])` — replay rejection is a database guarantee.
- **Test:** `adversarial › rejects a replayed webhook delivery`.

### T23 — Overselling stock
- **Surface:** concurrent payment orders for the last item.
- **Impact:** Medium.
- **Mitigation:** Conditional decrement (`where: { stock: { gte: quantity } }`), compensated if order creation fails.
- **Test:** `adversarial › only lets one of two concurrent payment orders succeed`.

### T24 — Unconfigured secret failing open
- **Impact:** Critical.
- **Mitigation:** Verification returns invalid when no secret is configured, and the config loader refuses to boot in production without one.
- **Test:** `payments › FAILS CLOSED when no secret is configured`.

---

## 4. Approval

### T25 — Unauthorized approval
- **Surface:** `POST …/approval` without credentials.
- **Impact:** Critical. **Was exploitable** — returned 200 (AUDIT_REPORT E-4).
- **Likelihood:** H.
- **Mitigation:** Requires an authenticated merchant session with OWNER or APPROVER role.
- **Test:** INVARIANT 8 — `rejects an unauthenticated approval`.

### T26 — Agent self-approval (confused deputy)
- **Impact:** Critical — defeats the entire human-in-the-loop control.
- **Mitigation:** Agent credentials are not a merchant session. Different auth scheme, different principal type, and the decision is attributed to a `MerchantUser` row.
- **Test:** INVARIANT 8 — `rejects an approval signed with agent credentials`.

### T27 — Approval replay
- **Impact:** High.
- **Mitigation:** `PENDING → APPROVED|DENIED` is a conditional update, so a second decision matches zero rows.
- **Test:** INVARIANT 6 — `rejects a replayed approval decision`.

### T28 — Approval phishing / link theft
- **Impact:** Medium.
- **Mitigation:** A one-time token is required *in addition to* a session, so possessing a link is not sufficient. The token is stored only as a SHA-256 digest and is stripped before any MCP response reaches the model.
- **Test:** INVARIANT 6 — `rejects an approval decision with a wrong token`.

### T29 — Expired approval accepted
- **Mitigation:** Deadline checked before any decision; expiry sweeps run every 60s.
- **Test:** INVARIANT 6 — `rejects an expired approval`.

### T30 — Approval granted after the budget is gone
- **Surface:** human approves slowly; the agent spends elsewhere meanwhile.
- **Impact:** Medium.
- **Mitigation:** Budget is reserved at approval time, not evaluation time. If the ledger refuses, the purchase is blocked despite the human's approval.
- **Code:** `approval-service.ts`, the `!reservation.ok` branch.

---

## 5. Access control

### T31 — Cross-merchant purchase
- **Impact:** Critical.
- **Likelihood:** M. **Was exploitable** — no check existed (AUDIT_REPORT E-7).
- **Mitigation:** `product.merchantId` must equal the authenticated agent's merchant.
- **Test:** `adversarial › refuses to purchase another merchant's product`.

### T32 — IDOR on reads
- **Impact:** High. Data disclosure across tenants.
- **Mitigation:** Every query is scoped by the authenticated principal's merchant. Cross-tenant access returns 404, never 403 — so the response cannot be used to enumerate.
- **Test:** five tests under `adversarial › tenant isolation`.

### T33 — Privilege escalation between roles
- **Impact:** High.
- **Mitigation:** `requireRole` on policy changes and approvals. A VIEWER cannot move money.
- **Test:** `adversarial › enforces role separation for policy changes`.

### T34 — Credential exposure to the browser
- **Impact:** Critical. **Was exploitable** — `NEXT_PUBLIC_ADMIN_KEY` shipped a privileged key into the client bundle (AUDIT_REPORT E-5).
- **Mitigation:** No admin key exists. The dashboard holds a short-lived session token scoped to one user and role.
- **Test:** `adversarial › rejects a forged bearer token`, `… revoked session`.

### T35 — Session theft from the database
- **Mitigation:** Only SHA-256 digests of session tokens are stored.

---

## 6. Audit

### T36 — Audit tampering
- **Impact:** Critical. Destroys accountability.
- **Likelihood:** M — requires database access.
- **Mitigation:** SHA-256 chain covering sequence, action, actor type, actor id, entity id, timestamp and metadata. Identity fields are inside the digest — the previous build hashed only action/timestamp/metadata, so *who did what* could be rewritten undetected.
- **Test:** INVARIANT 9 — `detects a modified event payload`, `detects a rewritten actor`.

### T37 — Audit deletion
- **Impact:** High.
- **Mitigation:** A gapless sequence column; a gap is proof of deletion.
- **Test:** INVARIANT 9 — `detects a deleted event`; `audit › detects a deleted event via the sequence gap`.

### T38 — Chain forking under concurrency
- **Impact:** High — makes verification unreliable, which is as bad as no verification. **Was occurring**: 3 forks in 89 events (AUDIT_REPORT D-5).
- **Mitigation:** The chain head advances by compare-and-swap; losers retry against the new tip.
- **Test:** exercised implicitly by every concurrency test, then verified by INVARIANT 9.

### T39 — Missing audit for a state change
- **Impact:** Medium.
- **Mitigation:** `recordAuditEvent` accepts a transaction handle, so state changes and their audit records commit together.
- **Test:** INVARIANT 9 — `records an audit event for every state change`.

---

## 7. Infrastructure and input

### T40 — Denial of service / rate-limit abuse
- **Impact:** Medium.
- **Mitigation:** Per-agent-key (falling back to per-IP) rate limiting; 256 KB body cap.
- **Test:** `adversarial › limits unauthenticated request floods`.
- **Gap:** in-process store; a shared store is needed behind multiple instances.

### T41 — SQL injection
- **Mitigation:** Prisma parameterizes everything; there is no raw SQL in the codebase.

### T42 — Prototype pollution / type confusion
- **Mitigation:** Strict Zod schemas strip unknown keys rather than merging them.
- **Test:** `adversarial › rejects prototype pollution`, `… object injection`.

### T43 — Secret leakage through logs
- **Impact:** High.
- **Mitigation:** Pino redaction at the transport, so no call site can forget: authorization, agent signature, webhook signature, cookies, passwords, tokens.
- **Test:** `adversarial › never returns a private key or password hash`.

### T44 — Internal detail in error responses
- **Mitigation:** A single central error handler; unexpected errors log server-side and return a generic message with a correlation id.
- **Test:** `adversarial › does not leak internal detail in a 500-class response`.

### T45 — XSS / CSRF
- **Mitigation:** React escapes by default; no `dangerouslySetInnerHTML`. Auth is a bearer token in a header, not a cookie, so CSRF does not apply. Agent-authored text (`agentReason`) is rendered as data.

### T46 — SSRF
- **Mitigation:** The only outbound request is to a configured payment host. No user-supplied URL is ever fetched.

### T47 — Malicious merchant/product metadata reaching the model
- **Surface:** a hostile product name or description echoed into the model's context by `search_products`.
- **Impact:** Medium — second-order prompt injection.
- **Likelihood:** M.
- **Mitigation:** Partial. Catalogue text is tenant-scoped and length-bounded, and injected instructions cannot escalate authority: the model still cannot set a price, exceed a limit, or approve. **This is a residual risk** — content sanitisation of catalogue text is not implemented. Documented rather than claimed.

---

## Residual risks

Honestly stated:

1. **T47** — catalogue text is not sanitised before reaching the model.
2. **T3** — no key rotation flow.
3. **T40** — rate limiting does not survive horizontal scaling.
4. Audit rows are deletable by the application's own database user; the chain makes
   deletion *detectable*, not *impossible*. Append-only storage or an external anchor
   would close this.
5. Threat-analyzer thresholds are hand-tuned, not empirically validated.
