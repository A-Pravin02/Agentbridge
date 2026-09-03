# Security Architecture

## The one-sentence version

AgentBridge treats the AI agent exactly the way a well-built web application treats a
browser: as an untrusted client that may submit anything, whose every claim is
re-derived server-side before it means anything.

## The trust boundary

```
        UNTRUSTED                    │           TRUSTED
                                     │
  LLM ── MCP tools ── signed HTTP ───┼──► Ed25519 verification
                                     │    ↓
  Anything the model says.           │    Permission passport   (from DB)
  Anything the frontend sends.       │    Product & price       (from DB)
  Anything a webhook claims,         │    Merchant policy       (from DB)
  until its HMAC is checked.         │    Daily budget          (from DB, atomic)
                                     │    Approval identity     (from session)
                                     │    Payment settlement    (from HMAC)
```

Everything on the left is a *proposal*. Everything on the right is *established*.

## What is never trusted

A checklist, because the failure mode is always the same — some field crosses the
boundary without being re-derived.

| Never trusted | Where truth comes from |
|---|---|
| Agent-claimed identity | Ed25519 signature over the canonical request |
| Agent-supplied price or amount | `product.priceMinor × quantity`, server-computed |
| Agent-supplied merchant id | `product.merchantId` |
| Agent-claimed spending headroom | The atomic ledger row |
| Agent-claimed payment success | HMAC over `orderId\|paymentId` |
| Client-side approval | An authenticated `MerchantUser` session |
| Client-side limits | The merchant policy row |
| A webhook's contents | HMAC over the raw body |
| An LLM's judgement about authorization | The deterministic policy engine |

## Agent identity: why Ed25519, not HMAC

The obvious design is a shared secret per agent, and HMAC on each request. It works,
but it has one uncomfortable property: **the verifier must hold a secret that can also
sign**. A database compromise, a log leak, or a curious operator can then impersonate
any agent.

AgentBridge uses Ed25519 instead:

- The agent holds a private key. The server stores only the 32-byte public key.
- The public key is public by construction — leaking it costs nothing.
- Nothing in the database, backups, or logs can forge an agent request.

That property is worth stating plainly to anyone reviewing this: *there is no secret
at rest capable of impersonating an agent.*

### The canonical request

```
AGENTBRIDGE-ED25519-V1
<keyId>
<requestId>          ← single-use nonce
<timestamp>          ← ±5 min window
<METHOD>
<path>               ← without query string
<sha256(raw body)>
```

Newline-separated, no field may contain a newline, so the encoding is unambiguous.
Binding all six fields means a signature cannot be:

- lifted onto a different route (path is signed),
- replayed later (timestamp + nonce),
- reused after editing any field (body digest),
- or reused at all (nonce is consumed via a unique index).

## Authentication vs authorization

Kept deliberately separate, because conflating them is how "who are you?" quietly
becomes "what may you do?".

| | Question | Mechanism | Location |
|---|---|---|---|
| **Authentication** | Who is asking? | Ed25519 (agents), scrypt + session token (humans) | `plugins/auth.ts` |
| **Authorization** | May they do this? | Permission passport, policy engine, ledger, roles | `policy-engine`, `services/` |

An agent that authenticates perfectly still gets nothing unless its passport,
the merchant policy, and the budget ledger all agree.

## The Agent Permission Passport

Issued by the merchant, stored server-side, never supplied by the agent:

```
canSearch / canCreatePurchaseIntent / canExecutePurchase
allowedCategories[]        deny-by-default: empty means nothing is permitted
allowedMerchantIds[]       empty means "no restriction beyond the owning merchant"
allowedCurrencies[]
maxTransactionMinor        per-transaction ceiling
maxDailyMinor              daily ceiling
maxTransactionsPerDay
maxPerMinute               velocity
allowedHoursUtc            optional window, may wrap midnight
expiresAt
```

Effective limits are `min(merchantPolicy, passport)` — the merchant can tighten but an
agent can never exceed its merchant's policy.

## Defence in depth: four layers under one attack

Take the negative-quantity attack, which in the previous build produced a
₹5,980 budget inflation. Four independent layers now stop it:

1. **Zod** — `quantity: int().min(1).max(1000)` → 400 before any logic runs.
2. **`multiplyMinor`** — throws on a non-positive quantity, so no code path can
   compute a negative total even if validation were bypassed.
3. **Database `CHECK`** — `("quantity" >= 1)` and `("amount_minor" >= 0)` reject the
   row at the storage layer.
4. **The ledger** — only accepts non-negative reservations.

No single layer is load-bearing. That is the point.

## The concurrency control point

This is the most important paragraph in the document.

Almost every spending-limit implementation is wrong in the same way:

```
spent = SELECT sum(...)          ← read
if (spent + amount > cap) refuse  ← decide
INSERT ...                        ← write
```

There is always a window between the read and the write. Two concurrent requests both
read the same pre-state and both pass. No amount of care in application code closes
it, because the check and the write are separate operations.

AgentBridge does not check the limit in application code. The limit **is** the
predicate of a single atomic statement:

```sql
UPDATE agent_daily_ledger
   SET reserved_minor = reserved_minor + :amount,
       txn_count      = txn_count + 1
 WHERE agent_id = :agent AND day = :day
   AND reserved_minor <= :dailyCap - :amount
   AND txn_count       < :countCap
```

The database evaluates the condition and applies the increment together, under a row
lock it takes itself. Zero rows updated means "this would have breached the limit" and
the caller is refused. There is no window.

Two consequences worth noting:

- It is correct on both SQLite and PostgreSQL, with no explicit locking and no
  non-default isolation level.
- The policy engine's daily-limit rule becomes *advisory* — it exists to explain the
  decision. The ledger is the authority, and when the two disagree (because a
  concurrent request landed in between), the ledger wins and the verdict is downgraded
  to BLOCK.

## Fail-closed by default

| Situation | Behaviour |
|---|---|
| Corrupt JSON in an allow-list column | Parses to `[]` → nothing permitted |
| No permission passport | Hard failure; the agent can do nothing |
| No merchant policy | Hard failure |
| Payment secret not configured | Verification returns invalid |
| Missing credential header | 401, not a skipped check |
| Production without secrets | Process refuses to start |
| Production with demo routes enabled | Process refuses to start |

## Secrets

- **No insecure defaults.** In production the config loader exits without real values.
  In development it generates an ephemeral per-boot value, which cannot silently
  become a production credential.
- **Nothing privileged reaches the browser.** The dashboard holds only a session token.
- **Log redaction at the transport**, so no call site can forget: authorization
  headers, agent signatures, webhook signatures, cookies, passwords, tokens.
- **Passwords** are scrypt with a per-user salt; verification is constant-time and runs
  even for unknown emails, so timing does not reveal account existence.
- **Session tokens** are stored only as SHA-256 digests.

## Error semantics

| Code | Meaning |
|---|---|
| 400 | Validation failed — the only case that returns field-level detail |
| 401 | Not authenticated. Identical message for unknown key and bad signature |
| 403 | Authenticated, not permitted. Generic message; specifics stay in the audit log |
| 404 | Not found **or** not yours — deliberately indistinguishable, to prevent enumeration |
| 409 | State conflict, idempotency conflict, or replayed approval |
| 429 | Rate limited |
| 500 | Unexpected. Logged in full server-side; the response carries only a correlation id |

## Escalation

Severe violations (replay, bad signature, cross-tenant access, approval replay,
webhook forgery, extreme frequency) accumulate:

- **2 severe within 10 minutes** → automatic quarantine.
- **8 total within 24 hours** → permanent block.

A quarantined agent is refused everything, including perfectly valid requests, until a
human with an approver role releases it. This composition is real and is why the test
suites reset incident state between cases — see the comments there.
