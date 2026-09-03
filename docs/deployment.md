# Deployment

## Local development

```bash
npm run setup     # install, select SQLite, migrate, seed
npm run dev       # API on :3001, dashboard on :3000
```

Sign in as `owner@techkart.demo` / `techkart-demo-2026`.

The seed writes `apps/api/.demo-agent.json` containing the demo agent's **private
key**. It is git-ignored. The database stores only the public key.

---

## Deployment shape

The API is a **long-running Fastify process** and the dashboard is a **static Next.js
app**. Those want different hosts:

```
  Browser
     |
     v
  Vercel  ──────────────►  Railway  ──────────►  PostgreSQL
  (Next.js dashboard)      (Fastify API)         (Neon / Railway)
```

### Why the API does not go on Vercel

Worth stating plainly, because "deploy everything to Vercel" is the obvious first
instinct and it does not work here:

| Requirement | Serverless | Consequence |
|---|---|---|
| SQLite file database | Ephemeral filesystem | Data is wiped between invocations |
| `app.listen()` | Functions, not processes | The server never starts |
| `setInterval` janitor | No long-lived process | Approval expiry never runs |
| In-process rate limiter | Per-invocation memory | The limit does not hold |

Every one of those is satisfied by a container platform. Railway is used below;
Render, Fly.io and any Docker host work identically.

---

## 1. PostgreSQL

Any managed Postgres works — [Neon](https://neon.tech) and Railway's own both have
free tiers. Create a database and copy its connection string.

Prisma requires `datasource.provider` to be a literal, so it cannot be switched by an
environment variable. Two schema files exist instead, differing **only** in that block:

```bash
npm run db:use:postgres   # or db:use:sqlite to go back
```

That copies the chosen schema into `prisma/schema.prisma` and the matching migrations
into `prisma/migrations`. It also **verifies the two variants have not drifted apart**
and refuses to switch if they have — a real risk when a model is added to one and not
the other.

The Postgres migration carries the same 18 `CHECK` constraints as the SQLite one, so a
negative amount is rejected at the storage layer on both engines.

### Verify the invariants against Postgres

Do this once. It converts "the concurrency design is engine-agnostic" from a claim into
evidence, and it is the single most valuable pre-deployment check:

```bash
npm run db:use:postgres && DATABASE_URL="postgresql://..." npm test
```

The concurrency invariants are the ones that matter. They should pass unchanged — the
budget ledger uses an atomic conditional `UPDATE` rather than `SELECT ... FOR UPDATE`
specifically so that it is correct on both engines with no isolation-level tuning.

> **Not yet done in this repository.** Docker would not start in the environment where
> this was built, so the Postgres path is configured and its DDL is generated, but the
> suite has only been run against SQLite. Run the command above before relying on it.

---

## 2. API on Railway

1. **New Project → Deploy from GitHub repo**, pick this repository.
2. Railway reads `railway.json` and builds the root `Dockerfile`. No further build
   configuration is needed.
3. Add a **PostgreSQL** service, or paste an external `DATABASE_URL`.
4. Set the variables below.
5. Deploy. The container runs `prisma migrate deploy` before starting, so the schema is
   applied automatically on first boot.

### Required variables

```bash
NODE_ENV=production
DATABASE_URL=postgresql://...          # Railway injects this if you add its Postgres

# 32+ chars each. Generate with: openssl rand -hex 32
SESSION_SECRET=...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...

PAYMENT_MODE=razorpay                  # sandbox is REFUSED in production
RAZORPAY_KEY_ID=rzp_test_...
ENABLE_DEMO_ROUTES=false               # true is REFUSED in production

ALLOWED_ORIGINS=https://your-app.vercel.app
```

`PORT` is injected by Railway and takes precedence over `API_PORT`. In production the
process binds `0.0.0.0` automatically; locally it stays on loopback so a dev machine
does not expose the API to its network.

The last two are the ones people get wrong. `ENABLE_DEMO_ROUTES=false` and
`PAYMENT_MODE=razorpay` are not advisory — the config loader **refuses to start** in
production otherwise, which is intentional: a demo endpoint that clears an agent's
quarantine must never reach production, and neither must a payment provider that
approves everything.

### Seeding

The seed creates demo data and should generally **not** run in production. If you want
the demo merchant on a deployed instance, run it once from the Railway shell:

```bash
npm run db:seed --workspace=@agentbridge/api
```

It prints the agent's private key to `.demo-agent.json` inside the container, which is
lost on redeploy. For a real agent, provision a key pair deliberately rather than
relying on the seed.

---

## 3. Dashboard on Vercel

1. **Add New → Project**, import the repository.
2. Set **Root Directory** to `apps/web`. This is the step that is easy to miss in a
   monorepo, and skipping it produces a confusing build failure.
3. `apps/web/vercel.json` supplies the build and install commands, which run from the
   repo root so workspace dependencies resolve.
4. Set one environment variable:

```bash
NEXT_PUBLIC_API_URL=https://your-api.up.railway.app
```

5. Deploy.

### Then close the CORS loop

Go back to Railway and set `ALLOWED_ORIGINS` to the Vercel URL. Redeploy the API.

If you skip this, the dashboard loads and every request fails in the browser with a
CORS error while working fine from `curl` — which is a genuinely confusing symptom, so
it is worth doing immediately.

---

## Production checklist

The config loader enforces the first four. The rest are on you.

- [ ] `NODE_ENV=production` — the process refuses to start without real secrets
- [ ] All three secrets set, 32+ chars (`openssl rand -hex 32`)
- [ ] `ENABLE_DEMO_ROUTES=false` — enforced
- [ ] `PAYMENT_MODE=razorpay` — enforced; sandbox is refused
- [ ] `ALLOWED_ORIGINS` matches the deployed dashboard origin exactly
- [ ] Invariant suite run once against PostgreSQL
- [ ] Automated database backups enabled
- [ ] Rate limiting moved to a shared store (Redis) **if running more than one
      replica** — the in-process limiter does not coordinate across instances, so N
      replicas means N times the intended limit
- [ ] Real agent key pairs provisioned; `.demo-agent.json` not shipped
- [ ] Demo approver account removed or its password rotated
- [ ] Razorpay webhook pointed at `https://<api-host>/api/webhooks/razorpay`,
      subscribed to `payment.captured`, with the secret matching
      `RAZORPAY_WEBHOOK_SECRET`

---

## Health and readiness

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness — the process is up |
| `GET /api/ready` | Readiness — returns 503 unless the database answers |

`railway.json` already points the platform health check at `/api/ready`, so a deploy
that cannot reach its database is rolled back rather than served.

---

## Background work

`apps/api/src/index.ts` runs a 60-second janitor that expires stale approvals and
purges dead nonces and idempotency keys. It is `unref`'d, so it never holds the process
open during shutdown.

Multiple replicas each run their own janitor. That is harmless — every operation is
idempotent and conditional — but a single scheduled worker is tidier at scale.

---

## Building the image locally

```bash
docker build -t agentbridge-api .
docker run --rm -p 3001:3001 \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://..." \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e RAZORPAY_KEY_SECRET="$(openssl rand -hex 32)" \
  -e RAZORPAY_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  -e PAYMENT_MODE=razorpay \
  -e ENABLE_DEMO_ROUTES=false \
  agentbridge-api
```

The image is multi-stage: the runtime layer carries compiled JavaScript, production
dependencies and the Prisma client — no TypeScript, no dev dependencies, no source. It
runs as the unprivileged `node` user.

CI builds this image on every push, so a broken Dockerfile fails there rather than on
the deployment platform.

---

## Environment reference

| Variable | Default | Note |
|---|---|---|
| `PORT` | — | Platform-injected; wins over `API_PORT` |
| `API_PORT` | 3001 | Local port |
| `API_HOST` | `127.0.0.1` dev, `0.0.0.0` prod | Containers must bind `0.0.0.0` |
| `DATABASE_URL` | `file:./dev.db` | Postgres URL in deployment |
| `SESSION_SECRET` | ephemeral in dev | Required in production |
| `RAZORPAY_KEY_SECRET` | ephemeral in dev | Required; verification fails closed without it |
| `RAZORPAY_WEBHOOK_SECRET` | ephemeral in dev | Required |
| `PAYMENT_MODE` | `sandbox` | Must be `razorpay` in production |
| `ENABLE_DEMO_ROUTES` | `true` | Must be `false` in production |
| `ALLOWED_ORIGINS` | localhost:3000 | Comma-separated browser origins |
| `RATE_LIMIT_MAX` | 100 | Per IP, per window |

In development, unset secrets are generated fresh on every boot. That is deliberate: a
dev default cannot silently become a production credential, and restarting invalidates
old sessions.
