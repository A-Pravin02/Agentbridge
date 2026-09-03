// ============================================
// AgentBridge - Database Seed
// ============================================
// Creates the TechKart demo merchant, its policy, catalogue, an approver
// account, and one agent with a freshly generated Ed25519 key pair.
//
// The agent's PRIVATE key is written to apps/api/.demo-agent.json (git-ignored)
// and is never stored in the database — the server keeps only the public key.

import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { generateAgentKeyPair, hashPassword } from '../src/lib/crypto.js';
import { toMinor, formatMinor } from '@agentbridge/shared-types';

const prisma = new PrismaClient();

const DEMO_PASSWORD = process.env.DEMO_APPROVER_PASSWORD ?? 'techkart-demo-2026';

async function main() {
  console.log('\nSeeding AgentBridge\n');

  const merchant = await prisma.merchant.upsert({
    where: { id: 'techkart_01' },
    update: {},
    create: { id: 'techkart_01', name: 'TechKart', status: 'ACTIVE' },
  });
  console.log(`  merchant   ${merchant.name}`);

  // ---- Approver account ----
  const approver = await prisma.merchantUser.upsert({
    where: { email: 'owner@techkart.demo' },
    update: {},
    create: {
      merchantId: merchant.id,
      email: 'owner@techkart.demo',
      passwordHash: await hashPassword(DEMO_PASSWORD),
      role: 'OWNER',
    },
  });
  console.log(`  user       ${approver.email} (OWNER)`);

  // ---- Catalogue. Prices in paise. ----
  const products = [
    ['prod_usb_cable', 'USB-C Cable', 'Braided 1.5m USB-C charging cable', 299, 'Electronics Accessories', 20],
    ['prod_phone_case', 'Premium Phone Case', 'Shockproof case, matte finish', 399, 'Phone Accessories', 12],
    ['prod_premium_case', 'Premium Case', 'Ultra-slim case with wireless charging support', 499, 'Phone Accessories', 8],
    ['prod_power_bank', 'Power Bank', '10000mAh fast-charging power bank', 1499, 'Electronics', 5],
    ['prod_bt_speaker', 'Bluetooth Speaker', 'Portable speaker, 12h battery', 2999, 'Electronics', 4],
    // Priced UNDER every limit on purpose: the only reason it is refused is the
    // category rule, which isolates that rule in the demo.
    ['prod_designer_watch', 'Designer Watch', 'Luxury analogue watch', 450, 'Luxury', 3],
  ] as const;

  for (const [id, name, description, rupees, category, stock] of products) {
    const p = await prisma.product.upsert({
      where: { id },
      update: { priceMinor: toMinor(rupees), stock, active: true },
      create: {
        id,
        merchantId: merchant.id,
        name,
        description,
        priceMinor: toMinor(rupees),
        currency: 'INR',
        category,
        stock,
      },
    });
    console.log(`  product    ${p.name.padEnd(20)} ${formatMinor(p.priceMinor).padStart(10)}  ${p.category}`);
  }

  // ---- Merchant policy ----
  const policyFields = {
    maxTransactionMinor: toMinor(500),
    maxDailyMinor: toMinor(2000),
    maxTransactionsPerDay: 5,
    allowedCategories: JSON.stringify([
      'Phone Accessories',
      'Electronics Accessories',
      'Electronics',
    ]),
    allowedCurrencies: JSON.stringify(['INR']),
    approvalThresholdMinor: toMinor(400),
    riskBlockThreshold: 80,
    riskApprovalThreshold: 60,
  };

  const policy = await prisma.policy.upsert({
    where: { merchantId: merchant.id },
    update: policyFields,
    create: {
      merchantId: merchant.id,
      version: 1,
      ...policyFields,
    },
  });
  console.log(
    `\n  policy     max ${formatMinor(policy.maxTransactionMinor)}/txn, ` +
      `${formatMinor(policy.maxDailyMinor)}/day, ${policy.maxTransactionsPerDay} txn/day, ` +
      `approval above ${formatMinor(policy.approvalThresholdMinor)}`
  );

  // ---- Agent + key pair ----
  const keys = generateAgentKeyPair();
  const agent = await prisma.agent.upsert({
    where: { id: 'agent_shopping_01' },
    update: { keyId: keys.keyId, publicKey: keys.publicKey, status: 'ACTIVE' },
    create: {
      id: 'agent_shopping_01',
      merchantId: merchant.id,
      name: 'Shopping Assistant',
      status: 'ACTIVE',
      keyId: keys.keyId,
      publicKey: keys.publicKey,
    },
  });

  const passportFields = {
    canSearch: true,
    canCreatePurchaseIntent: true,
    canExecutePurchase: true,
    allowedCategories: JSON.stringify([
      'Phone Accessories',
      'Electronics Accessories',
      'Electronics',
    ]),
    allowedMerchantIds: JSON.stringify([merchant.id]),
    allowedCurrencies: JSON.stringify(['INR']),
    maxTransactionMinor: toMinor(500),
    maxDailyMinor: toMinor(2000),
    maxTransactionsPerDay: 5,
    maxPerMinute: 30,
    allowedHoursUtc: null,
  };

  await prisma.agentPermission.upsert({
    where: { agentId: agent.id },
    update: passportFields,
    create: {
      agentId: agent.id,
      ...passportFields,
    },
  });
  console.log(`  agent      ${agent.name} (${agent.keyId})`);

  // Private key to disk, never to the database.
  const identityPath = join(process.cwd(), '.demo-agent.json');
  writeFileSync(
    identityPath,
    JSON.stringify(
      { agentId: agent.id, keyId: keys.keyId, privateKey: keys.privateKey, publicKey: keys.publicKey },
      null,
      2
    )
  );
  console.log(`  keypair    private key -> apps/api/.demo-agent.json (git-ignored)`);

  await prisma.auditChainHead.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton', sequence: -1, hash: 'GENESIS' },
  });

  console.log(`
Expected demo outcomes
  ${formatMinor(toMinor(299)).padStart(10)}  USB-C Cable          ALLOW
  ${formatMinor(toMinor(399)).padStart(10)}  Premium Phone Case   ALLOW
  ${formatMinor(toMinor(499)).padStart(10)}  Premium Case         REQUIRE_APPROVAL  (above the ${formatMinor(toMinor(400))} threshold)
  ${formatMinor(toMinor(1499)).padStart(10)}  Power Bank           BLOCK             (above the ${formatMinor(toMinor(500))} per-transaction cap)
  ${formatMinor(toMinor(2999)).padStart(10)}  Bluetooth Speaker    BLOCK             (far above the per-transaction cap)
  ${formatMinor(toMinor(450)).padStart(10)}  Designer Watch       BLOCK             (category "Luxury" is not permitted)

Merchant dashboard login
  owner@techkart.demo / ${DEMO_PASSWORD}
`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
