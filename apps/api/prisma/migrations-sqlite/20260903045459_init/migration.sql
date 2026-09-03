-- AgentBridge init migration.
-- CHECK constraints below are hand-added: they are the last line of defence
-- beneath Zod validation, so a negative amount cannot be persisted even if
-- every application-layer guard were bypassed.

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "merchant_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'APPROVER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "merchant_users_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" DATETIME,
    CONSTRAINT "sessions_merchant_user_id_fkey" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "key_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quarantined_at" DATETIME,
    "quarantine_reason" TEXT,
    "quarantine_triggered_by" TEXT,
    "security_violation_count" INTEGER NOT NULL DEFAULT 0,
    "severe_threat_count" INTEGER NOT NULL DEFAULT 0,
    "last_security_incident_at" DATETIME,
    CONSTRAINT "agents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_permissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "expires_at" DATETIME,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "agent_permissions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chk_agent_permissions_0" CHECK ("max_transaction_minor" >= 0),
    CONSTRAINT "chk_agent_permissions_1" CHECK ("max_daily_minor" >= 0),
    CONSTRAINT "chk_agent_permissions_2" CHECK ("max_transactions_per_day" >= 0),
    CONSTRAINT "chk_agent_permissions_3" CHECK ("max_per_minute" >= 0)
);

-- CreateTable
CREATE TABLE "policies" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "expires_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "policies_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chk_policies_0" CHECK ("max_transaction_minor" >= 0),
    CONSTRAINT "chk_policies_1" CHECK ("max_daily_minor" >= 0),
    CONSTRAINT "chk_policies_2" CHECK ("max_transactions_per_day" >= 0),
    CONSTRAINT "chk_policies_3" CHECK ("approval_threshold_minor" >= 0),
    CONSTRAINT "chk_policies_4" CHECK ("risk_block_threshold" BETWEEN 0 AND 100),
    CONSTRAINT "chk_policies_5" CHECK ("risk_approval_threshold" BETWEEN 0 AND 100)
);

-- CreateTable
CREATE TABLE "policy_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policy_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "policy_versions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "category" TEXT NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "products_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chk_products_0" CHECK ("price_minor" >= 0),
    CONSTRAINT "chk_products_1" CHECK ("stock" >= 0)
);

-- CreateTable
CREATE TABLE "purchase_intents" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "purchase_intents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "purchase_intents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "purchase_intents_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_purchase_intents_0" CHECK ("amount_minor" >= 0),
    CONSTRAINT "chk_purchase_intents_1" CHECK ("quantity" >= 1)
);

-- CreateTable
CREATE TABLE "authorizations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchase_intent_id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "human_reason" TEXT NOT NULL,
    "evaluated_rules" TEXT NOT NULL DEFAULT '[]',
    "policy_snapshot" TEXT NOT NULL DEFAULT '{}',
    "policy_version" INTEGER NOT NULL,
    "risk_score" INTEGER,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "authorizations_purchase_intent_id_fkey" FOREIGN KEY ("purchase_intent_id") REFERENCES "purchase_intents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchase_intent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "token_hash" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" DATETIME,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approvals_purchase_intent_id_fkey" FOREIGN KEY ("purchase_intent_id") REFERENCES "purchase_intents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "merchant_users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_daily_ledger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "reserved_minor" INTEGER NOT NULL DEFAULT 0,
    "txn_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "agent_daily_ledger_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chk_agent_daily_ledger_0" CHECK ("reserved_minor" >= 0),
    CONSTRAINT "chk_agent_daily_ledger_1" CHECK ("txn_count" >= 0)
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchase_intent_id" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "provider" TEXT NOT NULL,
    "provider_order_id" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verified_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "payments_purchase_intent_id_fkey" FOREIGN KEY ("purchase_intent_id") REFERENCES "purchase_intents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chk_payments_0" CHECK ("amount_minor" >= 0)
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "payload_digest" TEXT NOT NULL,
    "received_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sequence" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "previous_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chk_audit_events_0" CHECK ("sequence" >= 0)
);

-- CreateTable
CREATE TABLE "audit_chain_head" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "sequence" INTEGER NOT NULL DEFAULT -1,
    "hash" TEXT NOT NULL DEFAULT 'GENESIS',
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "security_incidents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "description" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "detected_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" DATETIME,
    "resolution" TEXT,
    CONSTRAINT "security_incidents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "threat_assessments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchase_intent_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "recommended_action" TEXT NOT NULL,
    "factors" TEXT NOT NULL DEFAULT '[]',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "threat_assessments_purchase_intent_id_fkey" FOREIGN KEY ("purchase_intent_id") REFERENCES "purchase_intents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "threat_assessments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idempotency_key" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "result_data" TEXT NOT NULL DEFAULT '{}',
    "status_code" INTEGER NOT NULL DEFAULT 200,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "consumed_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "consumed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL
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
