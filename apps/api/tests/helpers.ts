// ============================================
// Integration test harness
// ============================================
// Builds the REAL server and drives it over HTTP via `inject`. Nothing is
// mocked: the same routes, hooks, services and database the demo uses.

import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';

const API_ROOT = join(__dirname, '..');
const TEST_DB = join(API_ROOT, 'prisma', 'test.db');

// Set before anything imports config or the Prisma client.
process.env.NODE_ENV = 'test';

/**
 * The suite runs against whichever engine DATABASE_URL names.
 *
 * An externally supplied Postgres URL is honoured, so the same invariants can be
 * verified on the engine that will actually be deployed:
 *
 *   npm run db:use:postgres
 *   $env:DATABASE_URL = "postgresql://..."   # PowerShell
 *   npm test
 *
 * With nothing set, it falls back to a local SQLite file — the zero-setup path.
 * Overwriting the variable unconditionally (as this once did) silently ignored
 * the caller's database and made the Postgres run impossible.
 */
const EXTERNAL_DB = process.env.DATABASE_URL?.trim();
export const IS_POSTGRES = /^postgres(ql)?:\/\//i.test(EXTERNAL_DB ?? '');
process.env.DATABASE_URL = EXTERNAL_DB || `file:${TEST_DB.replace(/\\/g, '/')}`;

process.env.PAYMENT_MODE = 'sandbox';
process.env.RAZORPAY_KEY_ID = 'rzp_test_suite';
process.env.RAZORPAY_KEY_SECRET = 'test_secret_at_least_32_characters_long!';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret_32_characters_min!!!';
process.env.SESSION_SECRET = 'test_session_secret_32_characters_min!!!';
process.env.ENABLE_DEMO_ROUTES = 'false';
process.env.LOG_LEVEL = 'silent';
// High enough that the limiter never masks a security assertion.
process.env.RATE_LIMIT_MAX = '10000';

export interface AgentIdentity {
  agentId: string;
  keyId: string;
  privateKey: string;
  publicKey: string;
}

export interface TestWorld {
  app: FastifyInstance;
  merchantId: string;
  agent: AgentIdentity;
  productIds: Record<string, string>;
  ownerToken: string;
  ownerId: string;
}

/**
 * Empties every table in the public schema, in one statement.
 *
 * CASCADE handles the foreign-key graph so the order does not matter, and
 * RESTART IDENTITY resets sequences so ids do not drift between runs. Tables
 * are discovered from the catalogue rather than hard-coded, so a new model
 * cannot silently start leaking state across test files.
 */
function truncatePostgres(): void {
  const script = `
    const { PrismaClient } = require('@prisma/client');
    (async () => {
      const prisma = new PrismaClient();
      const rows = await prisma.$queryRawUnsafe(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'"
      );
      if (rows.length) {
        const list = rows.map((r) => '"' + r.tablename + '"').join(', ');
        await prisma.$executeRawUnsafe('TRUNCATE TABLE ' + list + ' RESTART IDENTITY CASCADE');
      }
      await prisma.$disconnect();
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  execFileSync('node', ['-e', script], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'pipe',
  });
}

/** Creates a fresh database from the migrations, on whichever engine is in use. */
export function resetDatabase(): void {
  // The Prisma CLI reads apps/api/.env, which pins the local SQLite URL. Passing
  // DATABASE_URL explicitly is not enough on its own — dotenv will not override
  // an existing variable, but the CLI is invoked as a separate process, so the
  // value has to travel with it.
  const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL };
  const run = (args: string[]) =>
    execFileSync('npx', ['prisma', ...args], {
      cwd: API_ROOT,
      env,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });

  if (IS_POSTGRES) {
    // Deliberately NOT `migrate reset`. That drops the schema, and a test
    // harness should never hold a loaded gun pointed at whatever database its
    // connection string happens to name.
    //
    // `migrate deploy` is idempotent and non-destructive: it applies any
    // missing migrations and does nothing on an up-to-date schema. Between runs
    // the tables are then emptied — which clears test data without touching the
    // schema, and is scoped to tables this schema owns.
    run(['migrate', 'deploy']);
    truncatePostgres();
    return;
  }

  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const f = `${TEST_DB}${suffix}`;
    if (existsSync(f)) rmSync(f, { force: true });
  }
  run(['migrate', 'deploy']);
}

/** Seeds a merchant, policy, owner and agent, and returns a driveable world. */
export async function createWorld(options: {
  maxTransactionMinor?: number;
  maxDailyMinor?: number;
  maxTransactionsPerDay?: number;
  approvalThresholdMinor?: number;
  allowedCategories?: string[];
} = {}): Promise<TestWorld> {
  const { prisma } = await import('../src/db.js');
  const { buildServer } = await import('../src/server.js');
  const { loadConfig } = await import('../src/config.js');
  const { generateAgentKeyPair, hashPassword } = await import('../src/lib/crypto.js');
  const { toMinor } = await import('@agentbridge/shared-types');

  const suffix = randomUUID().slice(0, 8);
  const merchant = await prisma.merchant.create({ data: { name: `Merchant ${suffix}` } });

  const password = 'owner-password-1234';
  const owner = await prisma.merchantUser.create({
    data: {
      merchantId: merchant.id,
      email: `owner-${suffix}@test.local`,
      passwordHash: await hashPassword(password),
      role: 'OWNER',
    },
  });

  const categories = options.allowedCategories ?? ['Phone Accessories', 'Electronics Accessories'];
  const maxTransactionMinor = options.maxTransactionMinor ?? toMinor(500);
  const maxDailyMinor = options.maxDailyMinor ?? toMinor(2000);
  const maxTransactionsPerDay = options.maxTransactionsPerDay ?? 5;

  await prisma.policy.create({
    data: {
      merchantId: merchant.id,
      version: 1,
      maxTransactionMinor,
      maxDailyMinor,
      maxTransactionsPerDay,
      allowedCategories: JSON.stringify(categories),
      allowedCurrencies: JSON.stringify(['INR']),
      approvalThresholdMinor: options.approvalThresholdMinor ?? toMinor(400),
      riskBlockThreshold: 80,
      riskApprovalThreshold: 60,
    },
  });

  const keys = generateAgentKeyPair();
  const agent = await prisma.agent.create({
    data: {
      merchantId: merchant.id,
      name: `Agent ${suffix}`,
      status: 'ACTIVE',
      keyId: keys.keyId,
      publicKey: keys.publicKey,
    },
  });

  await prisma.agentPermission.create({
    data: {
      agentId: agent.id,
      allowedCategories: JSON.stringify(categories),
      allowedMerchantIds: JSON.stringify([merchant.id]),
      allowedCurrencies: JSON.stringify(['INR']),
      maxTransactionMinor,
      maxDailyMinor,
      maxTransactionsPerDay,
      maxPerMinute: 1000,
    },
  });

  const catalogue: Array<[string, number, string]> = [
    ['cheap', 299, 'Electronics Accessories'],
    ['mid', 399, 'Phone Accessories'],
    ['approval', 499, 'Phone Accessories'],
    ['expensive', 1499, 'Electronics Accessories'],
    ['forbidden', 250, 'Luxury'],
  ];
  const productIds: Record<string, string> = {};
  for (const [key, rupees, category] of catalogue) {
    const p = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        name: `${key} product`,
        priceMinor: toMinor(rupees),
        currency: 'INR',
        category,
        stock: 100,
      },
    });
    productIds[key] = p.id;
  }

  await prisma.auditChainHead.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton', sequence: -1, hash: 'GENESIS' },
  });

  const app = await buildServer(loadConfig());
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: owner.email, password },
  });
  const ownerToken = login.json().data.token as string;

  return {
    app,
    merchantId: merchant.id,
    agent: {
      agentId: agent.id,
      keyId: keys.keyId,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    },
    productIds,
    ownerToken,
    ownerId: owner.id,
  };
}

export interface CallOptions {
  /** Transmit a different body than the one that was signed. */
  tamperBody?: unknown;
  /** Reuse a nonce to test replay protection. */
  nonce?: string;
  /** Reuse an idempotency key. */
  idempotencyKey?: string;
  omitSignature?: boolean;
  omitNonce?: boolean;
  /** Override the timestamp to test skew rejection. */
  timestamp?: string;
  /** Sign with a different key to test forgery. */
  signWith?: string;
}

/** Issues a correctly signed agent request unless told otherwise. */
export async function callAsAgent(
  world: TestWorld,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options: CallOptions = {}
) {
  const { buildCanonicalRequest, digestBody, signAsAgent } = await import('../src/lib/crypto.js');

  const payload = body === undefined ? '' : JSON.stringify(body);
  const requestId = options.nonce ?? randomUUID();
  const timestamp = options.timestamp ?? String(Date.now());

  const canonical = buildCanonicalRequest({
    keyId: world.agent.keyId,
    requestId,
    timestamp,
    method,
    path: path.split('?')[0],
    bodyDigest: digestBody(payload),
  });
  const signature = signAsAgent(options.signWith ?? world.agent.privateKey, canonical);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-agent-key-id': world.agent.keyId,
    'x-timestamp': timestamp,
    'idempotency-key': options.idempotencyKey ?? randomUUID(),
  };
  if (!options.omitNonce) headers['x-request-id'] = requestId;
  if (!options.omitSignature) headers['x-agent-signature'] = signature;

  const res = await world.app.inject({
    method,
    url: path,
    headers,
    payload: options.tamperBody !== undefined ? JSON.stringify(options.tamperBody) : payload,
  });

  return { status: res.statusCode, body: res.json() as any, requestId };
}

export async function callAsOwner(
  world: TestWorld,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  token = world.ownerToken
) {
  const res = await world.app.inject({
    method,
    url: path,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as any };
}

/** Drives create -> evaluate and returns both results. */
export async function createAndEvaluate(world: TestWorld, productKey: string, quantity = 1) {
  const created = await callAsAgent(world, 'POST', '/api/purchase-intents', {
    productId: world.productIds[productKey],
    quantity,
    agentReason: 'test',
  });
  if (created.status !== 200) return { created, evaluated: null, intentId: null };
  const intentId = created.body.data.id as string;
  const evaluated = await callAsAgent(
    world,
    'POST',
    `/api/purchase-intents/${intentId}/evaluate`,
    {}
  );
  return { created, evaluated, intentId };
}

/** Full happy path: create -> evaluate -> order -> settle with a real signature. */
export async function completePurchase(world: TestWorld, productKey: string) {
  const { intentId } = await createAndEvaluate(world, productKey);
  const order = await callAsAgent(
    world,
    'POST',
    `/api/purchase-intents/${intentId}/payment-order`,
    {}
  );
  const orderId = order.body.data.providerOrderId as string;
  const { signPayment } = await import('@agentbridge/payments');
  const paymentId = `pay_test_${randomUUID().slice(0, 12)}`;
  const signature = signPayment(orderId, paymentId, process.env.RAZORPAY_KEY_SECRET!);
  const settled = await callAsAgent(
    world,
    'POST',
    `/api/purchase-intents/${intentId}/verify-payment`,
    { providerPaymentId: paymentId, signature }
  );
  return { intentId, orderId, paymentId, signature, settled };
}
