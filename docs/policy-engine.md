# Policy Engine

The heart of AgentBridge. `packages/policy-engine` is a pure, I/O-free function.

```ts
evaluatePolicy(context: PolicyContext): PolicyResult
```

No database. No clock. No randomness. No network. **No language model.**

## The determinism contract

`now` and `decisionId` are *inputs*, not ambient reads. That is what makes a decision
reproducible: given the same context and policy version, the engine returns a
byte-identical result forever. It is why a decision can be replayed months later
against the policy snapshot that produced it, and why the reproducibility invariant is
testable at all.

```ts
const a = evaluatePolicy(ctx);
const b = evaluatePolicy(ctx);
JSON.stringify(a) === JSON.stringify(b);   // always true
```

The engine also never mutates its input.

## The fifteen rules

Each rule is an independent pure function `PolicyContext -> EvaluatedRule`. None
short-circuits the others: **every rule always runs**, so the dashboard can show which
checks were considered, not merely which one failed.

| # | Rule | Outcome on failure | Reason code |
|---|---|---|---|
| 1 | `AGENT_STATUS` | BLOCK | `AGENT_NOT_ACTIVE` |
| 2 | `AGENT_PERMISSION` | BLOCK | `AGENT_PERMISSION_DENIED` |
| 3 | `PERMISSION_EXPIRY` | BLOCK | `PERMISSION_EXPIRED` |
| 4 | `POLICY_EXPIRY` | BLOCK | `POLICY_EXPIRED` |
| 5 | `CURRENCY_ALLOWED` | BLOCK | `CURRENCY_NOT_ALLOWED` |
| 6 | `MERCHANT_ALLOWED` | BLOCK | `MERCHANT_NOT_ALLOWED` |
| 7 | `CATEGORY_ALLOWED` | BLOCK | `CATEGORY_NOT_ALLOWED` |
| 8 | `MAX_TRANSACTION_AMOUNT` | BLOCK | `TRANSACTION_LIMIT_EXCEEDED` |
| 9 | `DAILY_SPEND_LIMIT` | BLOCK | `DAILY_LIMIT_EXCEEDED` |
| 10 | `DAILY_TRANSACTION_COUNT` | BLOCK | `DAILY_COUNT_EXCEEDED` |
| 11 | `VELOCITY_LIMIT` | BLOCK | `VELOCITY_EXCEEDED` |
| 12 | `TIME_WINDOW` | BLOCK | `OUTSIDE_ALLOWED_HOURS` |
| 13 | `RISK_BLOCK_THRESHOLD` | BLOCK | `RISK_TOO_HIGH` |
| 14 | `RISK_APPROVAL_THRESHOLD` | REQUIRE_APPROVAL | `RISK_REQUIRES_APPROVAL` |
| 15 | `APPROVAL_AMOUNT_THRESHOLD` | REQUIRE_APPROVAL | `APPROVAL_THRESHOLD_EXCEEDED` |

Effective limits are `min(merchantPolicy, passport)` — a merchant may tighten an
agent's ceiling but an agent can never exceed its merchant's.

## Precedence

```
BLOCK  >  REQUIRE_APPROVAL  >  ALLOW
```

The verdict is a fold, not a first-match:

```ts
const decision = evaluatedRules.reduce(
  (acc, r) => mostRestrictive(acc, r.outcome),
  PolicyDecision.ALLOW
);
```

Two properties follow, and both are tested:

- **Order-independence.** Reordering the rule list cannot change the verdict. Order
  affects only presentation.
- **Risk can escalate, never downgrade.** A CRITICAL risk score can turn ALLOW into
  BLOCK. Nothing — no risk score, no low threat level, no combination — can turn a
  hard policy BLOCK into an ALLOW.

The *headline reason* is the first violation whose outcome is as restrictive as the
final verdict, so the reason shown always matches the decision made.

## Output

```jsonc
{
  "decisionId": "3f9a...",
  "decision": "BLOCK",
  "reasonCode": "TRANSACTION_LIMIT_EXCEEDED",
  "humanReadableReason": "Transaction amount ₹1,499.00 exceeds the per-transaction limit of ₹500.00",
  "evaluatedRules": [ /* all 15, passing and failing */ ],
  "violations":     [ /* only the failures */ ],
  "policyVersion": 7,
  "timestamp": "2026-09-03T12:00:00.000Z"
}
```

`evaluatedRules` is what powers the dashboard timeline. Showing the checks that passed
is deliberate: the useful question for a merchant is rarely "what blocked this" but
"what was actually considered".

## The ledger is the authority

The engine's daily-limit rule (#9) is **advisory**. It runs against a usage snapshot
read a moment earlier, and a concurrent request can invalidate it before the write.

Enforcement is the atomic reservation in `ledger-service.ts`. When the engine says
ALLOW but the ledger refuses, the ledger wins and the verdict is downgraded to BLOCK
with reason `DAILY_LIMIT_EXCEEDED`.

Rule #9 exists so a merchant can see *why* — not to enforce.

## Risk integration

The threat analyzer (`packages/threat-analyzer`) produces a transparent 0-100 score
from eleven behavioural rules: request frequency, blocked-attempt streaks, policy
probing, near-limit probing, spending spikes, rapid escalation, category switching,
denied approvals, and a bonus when three or more fire together.

It is deliberately not a model. Every point is attributable:

```
Risk 82/100 (CRITICAL)
  +50  15 purchase attempts in the last 60 seconds
  +30  4 blocked attempts in the last 10 minutes
  +20  3 distinct threat indicators simultaneously
```

The score feeds rules 13 and 14. Both thresholds are merchant-configurable.

## Adding a rule

1. Write a pure function in `packages/policy-engine/src/rules.ts`.
2. Add it to `POLICY_RULES`.
3. Add the enum member and reason code in `shared-types/src/enums.ts`.
4. Test the pass case, the fail case, and the boundary.

Because the verdict is a fold, adding a rule cannot change any existing decision
except by making it more restrictive.
