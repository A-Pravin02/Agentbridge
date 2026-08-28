// ============================================
// AgentBridge - Database Seed
// Creates TechKart demo merchant, products, policy, and agent
// ============================================

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding AgentBridge database...\n');

  // ---- Create Merchant: TechKart ----
  const merchant = await prisma.merchant.upsert({
    where: { id: 'techkart_01' },
    update: {},
    create: {
      id: 'techkart_01',
      name: 'TechKart',
      status: 'ACTIVE',
    },
  });
  console.log(`✅ Merchant: ${merchant.name} (${merchant.id})`);

  // ---- Create Products ----
  const products = [
    {
      id: 'prod_usb_cable',
      merchantId: merchant.id,
      name: 'USB-C Cable',
      description: 'High-quality braided USB-C charging cable, 1.5m length',
      price: 299,
      currency: 'INR',
      category: 'Electronics Accessories',
      stock: 20,
    },
    {
      id: 'prod_phone_case',
      merchantId: merchant.id,
      name: 'Premium Phone Case',
      description: 'Shockproof premium phone case with matte finish',
      price: 399,
      currency: 'INR',
      category: 'Phone Accessories',
      stock: 12,
    },
    {
      id: 'prod_premium_case',
      merchantId: merchant.id,
      name: 'Premium Case',
      description: 'Ultra-slim premium protective case with wireless charging support',
      price: 499,
      currency: 'INR',
      category: 'Phone Accessories',
      stock: 8,
    },
    {
      id: 'prod_power_bank',
      merchantId: merchant.id,
      name: 'Power Bank',
      description: '10000mAh fast charging power bank with dual USB ports',
      price: 1499,
      currency: 'INR',
      category: 'Electronics',
      stock: 5,
    },
    {
      id: 'prod_bt_speaker',
      merchantId: merchant.id,
      name: 'Bluetooth Speaker',
      description: 'Portable wireless Bluetooth speaker with 12hr battery life',
      price: 2999,
      currency: 'INR',
      category: 'Electronics',
      stock: 4,
    },
  ];

  for (const product of products) {
    const p = await prisma.product.upsert({
      where: { id: product.id },
      update: { stock: product.stock, price: product.price },
      create: product,
    });
    console.log(`  📦 Product: ${p.name} — ₹${p.price} (${p.category}) [Stock: ${p.stock}]`);
  }

  // ---- Create Policy (arrays stored as JSON strings for SQLite) ----
  const allowedCategories = JSON.stringify(['Phone Accessories', 'Electronics Accessories']);

  const policy = await prisma.policy.upsert({
    where: { id: 'policy_techkart_01' },
    update: {},
    create: {
      id: 'policy_techkart_01',
      merchantId: merchant.id,
      maxTransactionAmount: 500,
      maxDailyAmount: 2000,
      maxTransactionsPerDay: 5,
      allowedCategories: allowedCategories,
      approvalThreshold: 400,
    },
  });
  console.log(`\n✅ Policy: Max ₹${policy.maxTransactionAmount}/txn, ₹${policy.maxDailyAmount}/day, Approval > ₹${policy.approvalThreshold}`);

  // ---- Create Agent ----
  const agent = await prisma.agent.upsert({
    where: { id: 'agent_shopping_01' },
    update: {},
    create: {
      id: 'agent_shopping_01',
      merchantId: merchant.id,
      name: 'Shopping Assistant',
      status: 'ACTIVE',
    },
  });
  console.log(`\n✅ Agent: ${agent.name} (${agent.id})`);

  // ---- Create Agent Permission (Passport) ----
  const agentCategories = JSON.stringify(['Phone Accessories', 'Electronics Accessories']);

  const permission = await prisma.agentPermission.upsert({
    where: { id: 'perm_shopping_01' },
    update: {},
    create: {
      id: 'perm_shopping_01',
      agentId: agent.id,
      canSearch: true,
      canCreatePurchaseIntent: true,
      canExecutePurchase: true,
      allowedCategories: agentCategories,
      maxTransactionAmount: 500,
      maxDailyAmount: 2000,
      expiresAt: null,
    },
  });
  console.log(`  🪪 Permission Passport: search=${permission.canSearch}, purchase=${permission.canExecutePurchase}`);
  console.log(`  💰 Limits: ₹${permission.maxTransactionAmount}/txn, ₹${permission.maxDailyAmount}/day`);
  console.log(`  📂 Categories: ${permission.allowedCategories}`);

  console.log('\n✅ Seed complete!\n');
  console.log('Expected Demo Results:');
  console.log('  ₹299 USB-C Cable        → ALLOW');
  console.log('  ₹399 Premium Phone Case  → ALLOW');
  console.log('  ₹499 Premium Case        → REQUIRE_APPROVAL (above ₹400 threshold)');
  console.log('  ₹1499 Power Bank         → BLOCK (exceeds ₹500 limit)');
  console.log('  ₹2999 Bluetooth Speaker  → BLOCK (exceeds ₹500 limit)');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
