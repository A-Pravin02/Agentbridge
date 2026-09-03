# Deployment

## Local development

```bash
npm run setup     # install, migrate, seed
npm run dev       # API on :3001, dashboard on :3000
```

Sign in as `owner@techkart.demo` / `techkart-demo-2026`.

The seed writes `apps/api/.demo-agent.json` containing the demo agent's **private
key**. It is git-ignored. The database stores only the public key.

---

## Moving to PostgreSQL

The default is SQLite so the project clones and runs with no external services. Every
concurrency control is engine-agnostic — the budget ledger uses an atomic conditional
`UPDATE` rather than `SELECT ... FOR UPDATE`, which is correct on both engines and
needs no special isolation level. Switching is therefore a datasource change, not a
logic change.

**1. Start Postgres**

```bash
docker run -d --name agentbridge-pg \
  -e POSTGRES_USER=agentbridge \
  -e POSTGRES_PASSWORD=<strong-password> \
  -e POSTGRES_DB=agentbridge \
  -p 5432:5432 postgres:16-alpine
```

**2. Point the schema at it**

In `apps/api/prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

**3. Regenerate the migration**

The committed migration is SQLite DDL. Generate the Postgres equivalent:

```bash
cd apps/api
rm -rf prisma/migrations
DATABASE_URL="postgresql://..." npx prisma migrate dev --name init --create-only
```

**4. Re-add the CHECK constraints**

Prisma does not model `CHECK` constraints, so they are hand-added to the migration.
Append this to the generated `migration.sql` before applying:

```sql
ALTER TABLE "products"            ADD CONSTRAINT chk_products_price      CHECK (price_minor >= 0);
ALTER TABLE "products"            ADD CONSTRAINT chk_products_stock      CHECK (stock >= 0);
ALTER TABLE "purchase_intents"    ADD CONSTRAINT chk_intent_amount       CHECK (amount_minor >= 0);
ALTER TABLE "purchase_intents"    ADD CONSTRAINT chk_intent_quantity     CHECK (quantity >= 1);
ALTER TABLE "agent_daily_ledger"  ADD CONSTRAINT chk_ledger_reserved     CHECK (reserved_minor >= 0);
ALTER TABLE "agent_daily_ledger"  ADD CONSTRAINT chk_ledger_count        CHECK (txn_count >= 0);
ALTER TABLE "payments"            ADD CONSTRAINT chk_payment_amount      CHECK (amount_minor >= 0);
ALTER TABLE "audit_events"        ADD CONSTRAINT chk_audit_sequence      CHECK (sequence >= 0);
ALTER TABLE "policies"            ADD CONSTRAINT chk_policy_risk_block   CHECK (risk_block_threshold BETWEEN 0 AND 100);
ALTER TABLE "policies"            ADD CONSTRAINT chk_policy_risk_approve CHECK (risk_approval_threshold BETWEEN 0 AND 100);
```

Then `npx prisma migrate deploy && npx prisma generate`.

**5. Run the suite against Postgres**

```bash
DATABASE_URL="postgresql://..." npm test
```

The concurrency invariants are the ones that matter here. They should pass unchanged —
that is the point of the atomic-CAS design.

---

## Live Razorpay test mode

```bash
PAYMENT_MODE="razorpay"
RAZORPAY_KEY_ID="rzp_test_..."
RAZORPAY_KEY_SECRET="..."
RAZORPAY_WEBHOOK_SECRET="..."
```

In the Razorpay dashboard, add a webhook pointing at
`https://<your-host>/api/webhooks/razorpay`, subscribe to `payment.captured`, and set
the webhook secret to match.

Nothing in the verification path changes. `verifyPaymentSignature` and
`verifyWebhookSignature` are the same functions in both modes; only the counterparty
that mints signatures differs.

---

## Production checklist

The config loader enforces the first four; the rest are on you.

- [ ] `NODE_ENV=production` — the process **refuses to start** without real secrets
- [ ] `SESSION_SECRET`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` set, 32+ chars
      each (`openssl rand -hex 32`)
- [ ] `ENABLE_DEMO_ROUTES=false` — enforced; startup fails otherwise
- [ ] `PAYMENT_MODE=razorpay` — enforced; sandbox is refused in production
- [ ] `ALLOWED_ORIGINS` set to your real dashboard origin
- [ ] `API_HOST` bound behind a reverse proxy, TLS terminated upstream
- [ ] PostgreSQL with automated backups
- [ ] Rate limiting moved to a shared store (Redis) if running more than one instance —
      the in-process limiter does not coordinate across replicas
- [ ] Log shipping configured; redaction is already applied at the transport
- [ ] Re-seed or provision real agent key pairs; do **not** ship `.demo-agent.json`
- [ ] Rotate the demo approver password, or delete the account

---

## Health and readiness

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness. Returns ok if the process is up |
| `GET /api/ready` | Readiness. Returns 503 unless the database answers |

Point your orchestrator's liveness probe at `/api/health` and its readiness probe at
`/api/ready`.

---

## Background work

`apps/api/src/index.ts` runs a 60-second janitor that expires stale approvals and
purges dead nonces and idempotency keys. It is `unref`'d, so it never holds the
process open.

Running multiple replicas will run the janitor on each. That is harmless — every
operation is idempotent and conditional — but a single scheduled worker is tidier at
scale.

---

## Environment reference

See `.env.example`. The security-relevant entries:

| Variable | Default | Note |
|---|---|---|
| `SESSION_SECRET` | ephemeral in dev | Required in production |
| `RAZORPAY_KEY_SECRET` | ephemeral in dev | Required; verification fails closed without it |
| `RAZORPAY_WEBHOOK_SECRET` | ephemeral in dev | Required |
| `PAYMENT_MODE` | `sandbox` | Must be `razorpay` in production |
| `ENABLE_DEMO_ROUTES` | `true` | Must be `false` in production |
| `REQUEST_SKEW_MS` | 300000 | Signed-request timestamp window |
| `AUTHORIZATION_TTL_MS` | 900000 | How long an authorization stays valid |
| `APPROVAL_TTL_MS` | 600000 | How long a human has to decide |
| `RATE_LIMIT_MAX` | 100 | Per key or IP, per window |

In development, unset secrets are generated fresh on every boot. That is deliberate:
a dev default cannot silently become a production credential, and restarting
invalidates old sessions.
