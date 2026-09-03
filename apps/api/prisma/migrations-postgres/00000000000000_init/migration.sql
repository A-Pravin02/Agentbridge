-- AgentBridge — PostgreSQL init migration.
--
-- Generated offline with `prisma migrate diff`, then extended with the CHECK
-- constraints below. Prisma does not model CHECK constraints, so they are added
-- by hand — exactly as in the SQLite migration. They are the last line of
-- defence beneath Zod validation: a negative amount cannot be persisted even if
-- every application-layer guard were bypassed.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_users" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'APPROVER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "merchant_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "key_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quarantined_at" TIMESTAMP(3),
    "quarantine_reason" TEXT,
    "quarantine_triggered_by" TEXT,
    "security_violation_count" INTEGER NOT NULL DEFAULT 0,
    "severe_threat_count" INTEGER NOT NULL DEFAULT 0,
    "last_security_incident_at" TIMESTAMP(3),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_permissions" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "can_search" BOOLEAN NOT NULL DEFAULT true,
    "can_create_purchase_intent" BOOLEAN NOT NULL DEFAULT true,
    "can_execute_purchase" BOOLEAN NOT NULL DEFAULT true,
    "allowed_categories" TEXT NOT NULL DEFAULT '[]',
    "allowed_merchant_ids" TEXT NOT NULL DEFAULT '[]',
    "allowed_currencies" TEXT NOT NULL DEFAULT '["INR"]',
    "max_transaction_minor" INTEGER NOT NULL,
    "max_daily_minor" INTEGER NOT NULL,
    "max_transactions_per_day" INTEGER NOT NULL DEFAULT 20,
    "max_per_minute" INTEGER NOT NULL DEFAULT 10,
    "allowed_hours_utc" TEXT,
    "expires_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "max_transaction_minor" INTEGER NOT NULL,
    "max_daily_minor" INTEGER NOT NULL,
    "max_transactions_per_day" INTEGER NOT NULL,
    "allowed_categories" TEXT NOT NULL DEFAULT '[]',
    "allowed_currencies" TEXT NOT NULL DEFAULT '["INR"]',
    "approval_threshold_minor" INTEGER NOT NULL,
    "risk_block_threshold" INTEGER NOT NULL DEFAULT 80,
    "risk_approval_threshold" INTEGER NOT NULL DEFAULT 60,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_versions" (
    "id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "category" TEXT NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_intents" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "agent_reason" TEXT NOT NULL DEFAULT '',
    "budget_held" BOOLEAN NOT NULL DEFAULT false,
    "ledger_day" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authorizations" (
    "id" TEXT NOT NULL,
    "purchase_intent_id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "human_reason" TEXT NOT NULL,
    "evaluated_rules" TEXT NOT NULL DEFAULT '[]',
    "policy_snapshot" TEXT NOT NULL DEFAULT '{}',
    "policy_version" INTEGER NOT NULL,
    "risk_score" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "purchase_intent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "token_hash" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_daily_ledger" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "reserved_minor" INTEGER NOT NULL DEFAULT 0,
    "txn_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_daily_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "purchase_intent_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "provider" TEXT NOT NULL,
    "provider_order_id" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "payload_digest" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "previous_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_chain_head" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "sequence" INTEGER NOT NULL DEFAULT -1,
    "hash" TEXT NOT NULL DEFAULT 'GENESIS',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_chain_head_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_incidents" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "description" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "security_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "threat_assessments" (
    "id" TEXT NOT NULL,
    "purchase_intent_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "recommended_action" TEXT NOT NULL,
    "factors" TEXT NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "threat_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "result_data" TEXT NOT NULL DEFAULT '{}',
    "status_code" INTEGER NOT NULL DEFAULT 200,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumed_requests" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "consumed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consumed_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_users_email_key" ON "merchant_users"("email");

-- CreateIndex
CREATE INDEX "merchant_users_merchant_id_idx" ON "merchant_users"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agents_key_id_key" ON "agents"("key_id");

-- CreateIndex
CREATE INDEX "agents_merchant_id_status_idx" ON "agents"("merchant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_permissions_agent_id_key" ON "agent_permissions"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "policies_merchant_id_key" ON "policies"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "policy_versions_policy_id_version_key" ON "policy_versions"("policy_id", "version");

-- CreateIndex
CREATE INDEX "products_merchant_id_category_idx" ON "products"("merchant_id", "category");

-- CreateIndex
CREATE INDEX "purchase_intents_agent_id_status_created_at_idx" ON "purchase_intents"("agent_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "purchase_intents_merchant_id_created_at_idx" ON "purchase_intents"("merchant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "authorizations_decision_id_key" ON "authorizations"("decision_id");

-- CreateIndex
CREATE INDEX "authorizations_purchase_intent_id_created_at_idx" ON "authorizations"("purchase_intent_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_token_hash_key" ON "approvals"("token_hash");

-- CreateIndex
CREATE INDEX "approvals_status_expires_at_idx" ON "approvals"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_daily_ledger_agent_id_day_key" ON "agent_daily_ledger"("agent_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_order_id_key" ON "payments"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_purchase_intent_id_idx" ON "payments"("purchase_intent_id");

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_provider_event_id_key" ON "webhook_events"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_sequence_key" ON "audit_events"("sequence");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_hash_key" ON "audit_events"("hash");

-- CreateIndex
CREATE INDEX "audit_events_entity_id_sequence_idx" ON "audit_events"("entity_id", "sequence");

-- CreateIndex
CREATE INDEX "audit_events_action_sequence_idx" ON "audit_events"("action", "sequence");

-- CreateIndex
CREATE INDEX "security_incidents_agent_id_detected_at_idx" ON "security_incidents"("agent_id", "detected_at");

-- CreateIndex
CREATE INDEX "security_incidents_severity_detected_at_idx" ON "security_incidents"("severity", "detected_at");

-- CreateIndex
CREATE INDEX "threat_assessments_agent_id_created_at_idx" ON "threat_assessments"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "threat_assessments_purchase_intent_id_created_at_idx" ON "threat_assessments"("purchase_intent_id", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_agent_id_idempotency_key_key" ON "idempotency_records"("agent_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "consumed_requests_expires_at_idx" ON "consumed_requests"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "consumed_requests_agent_id_request_id_key" ON "consumed_requests"("agent_id", "request_id");

-- AddForeignKey
ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_merchant_user_id_fkey" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_permissions" ADD CONSTRAINT "agent_permissions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_purchase_intent_id_fkey" FOREIGN KEY ("purchase_intent_id") REFERENCES "purchase_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_purchase_intent_id_fkey" FOREIGN KEY ("purchase_intent_id") REFERENCES "purchase_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "merchant_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_daily_ledger" ADD CONSTRAINT "agent_daily_ledger_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_purchase_intent_id_fkey" FOREIGN KEY ("purchase_intent_id") REFERENCES "purchase_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threat_assessments" ADD CONSTRAINT "threat_assessments_purchase_intent_id_fkey" FOREIGN KEY ("purchase_intent_id") REFERENCES "purchase_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threat_assessments" ADD CONSTRAINT "threat_assessments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================
-- CHECK constraints (hand-added; see header)
-- ============================================

ALTER TABLE "products"           ADD CONSTRAINT "chk_products_price"       CHECK ("price_minor" >= 0);
ALTER TABLE "products"           ADD CONSTRAINT "chk_products_stock"       CHECK ("stock" >= 0);
ALTER TABLE "purchase_intents"   ADD CONSTRAINT "chk_intent_amount"        CHECK ("amount_minor" >= 0);
ALTER TABLE "purchase_intents"   ADD CONSTRAINT "chk_intent_quantity"      CHECK ("quantity" >= 1);
ALTER TABLE "agent_permissions"  ADD CONSTRAINT "chk_perm_max_txn"         CHECK ("max_transaction_minor" >= 0);
ALTER TABLE "agent_permissions"  ADD CONSTRAINT "chk_perm_max_daily"       CHECK ("max_daily_minor" >= 0);
ALTER TABLE "agent_permissions"  ADD CONSTRAINT "chk_perm_max_per_day"     CHECK ("max_transactions_per_day" >= 0);
ALTER TABLE "agent_permissions"  ADD CONSTRAINT "chk_perm_max_per_minute"  CHECK ("max_per_minute" >= 0);
ALTER TABLE "policies"           ADD CONSTRAINT "chk_policy_max_txn"       CHECK ("max_transaction_minor" >= 0);
ALTER TABLE "policies"           ADD CONSTRAINT "chk_policy_max_daily"     CHECK ("max_daily_minor" >= 0);
ALTER TABLE "policies"           ADD CONSTRAINT "chk_policy_max_per_day"   CHECK ("max_transactions_per_day" >= 0);
ALTER TABLE "policies"           ADD CONSTRAINT "chk_policy_approval"      CHECK ("approval_threshold_minor" >= 0);
ALTER TABLE "policies"           ADD CONSTRAINT "chk_policy_risk_block"    CHECK ("risk_block_threshold" BETWEEN 0 AND 100);
ALTER TABLE "policies"           ADD CONSTRAINT "chk_policy_risk_approve"  CHECK ("risk_approval_threshold" BETWEEN 0 AND 100);
ALTER TABLE "agent_daily_ledger" ADD CONSTRAINT "chk_ledger_reserved"      CHECK ("reserved_minor" >= 0);
ALTER TABLE "agent_daily_ledger" ADD CONSTRAINT "chk_ledger_count"         CHECK ("txn_count" >= 0);
ALTER TABLE "payments"           ADD CONSTRAINT "chk_payment_amount"       CHECK ("amount_minor" >= 0);
ALTER TABLE "audit_events"       ADD CONSTRAINT "chk_audit_sequence"       CHECK ("sequence" >= 0);
