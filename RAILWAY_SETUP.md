# Railway setup — exact settings

Railway auto-detected the npm workspaces and created one service per workspace,
building each with **Nixpacks**. That ignores the root `Dockerfile` and produces a
container that cannot start. These are the settings that make it work.

## 1. Delete the `@agentbridge/mcp` service

The MCP server communicates over **stdio** with a local AI client. It has no HTTP
port and no health endpoint, and it exits immediately without an agent private key.
Deployed as a web service it crash-loops forever and consumes half your credit.

Click the service → **Settings** → scroll to the bottom → **Delete Service**.

## 2. Point the API service at the Dockerfile

Click **`@agentbridge/api`** → **Settings**:

| Setting | Value |
|---|---|
| **Root Directory** | `/` (empty — the repo root, NOT `apps/api`) |
| **Builder** | `Dockerfile` |
| **Dockerfile Path** | `Dockerfile` |
| **Start Command** | leave empty — the Dockerfile's `CMD` handles it |
| **Health Check Path** | `/api/ready` |

Root Directory is the one that matters. Scoped to `apps/api`, Railway cannot see the
root `Dockerfile`, the workspace packages, or the lockfile, so the build has no way
to succeed.

## 3. Variables

**Settings → Variables → Raw Editor.** Replace everything with:

```
NODE_ENV=development
DATABASE_URL=<your Neon connection string>
SESSION_SECRET=<32+ chars>
RAZORPAY_KEY_SECRET=<32+ chars>
RAZORPAY_WEBHOOK_SECRET=<32+ chars>
PAYMENT_MODE=sandbox
RAZORPAY_KEY_ID=rzp_test_sandbox
ENABLE_DEMO_ROUTES=true
ALLOWED_ORIGINS=https://your-app.vercel.app
LOG_LEVEL=info
```

**Do not set `API_HOST` or `API_PORT`.** Railway injects `PORT`, and the server then
binds `0.0.0.0` on its own. An explicit `API_HOST=127.0.0.1` — which Railway may have
seeded from `.env.example` — binds loopback inside the container and produces
`502 Application failed to respond`. If that variable exists, delete it.

`NODE_ENV=development` is deliberate: it is what permits the sandbox payment provider
and the demo routes. The config loader refuses both under `production`, by design.

## 4. Generate a domain

**Settings → Networking → Generate Domain.** Railway does not expose a service
publicly by default, so a service can be "online" and still unreachable.

## 5. Verify

```
curl https://<your-domain>/api/ready
```

Expected: `{"status":"ready","database":"connected"}`

A 200 from `/api/health` only proves the process is alive. `/api/ready` returns 503
unless the database actually answers, which is the difference between "it started"
and "it works".

## Already done for you

The Neon **production** branch has the schema applied and the TechKart demo data
seeded, verified by running the full attack console against it: 14/14 scenarios,
10/10 attacks stopped. So once the container is reachable, there is nothing further
to set up.

Dashboard login: `owner@techkart.demo` / `techkart-demo-2026`

## If Railway keeps fighting the monorepo

Render is a reasonable fallback and needs no card:

1. New → **Web Service** → connect the repo
2. Runtime: **Docker**, Dockerfile Path: `./Dockerfile`, Root Directory: blank
3. Same variables as above
4. Health check path: `/api/ready`

The trade-off is that a free Render service sleeps after 15 minutes idle and takes
around 30 seconds to wake — worth knowing before a live demo.
