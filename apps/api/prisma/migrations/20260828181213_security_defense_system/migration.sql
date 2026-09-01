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
    CONSTRAINT "security_incidents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    CONSTRAINT "threat_assessments_purchase_intent_id_fkey" FOREIGN KEY ("purchase_intent_id") REFERENCES "purchase_intents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "threat_assessments_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "result_data" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "consumed_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "consumed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quarantined_at" DATETIME,
    "quarantine_reason" TEXT,
    "quarantine_triggered_by" TEXT,
    "security_violation_count" INTEGER NOT NULL DEFAULT 0,
    "severe_threat_count" INTEGER NOT NULL DEFAULT 0,
    "last_security_incident_at" DATETIME,
    "signing_secret" TEXT,
    CONSTRAINT "agents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_agents" ("created_at", "id", "merchant_id", "name", "status") SELECT "created_at", "id", "merchant_id", "name", "status" FROM "agents";
DROP TABLE "agents";
ALTER TABLE "new_agents" RENAME TO "agents";
CREATE INDEX "agents_merchant_id_status_idx" ON "agents"("merchant_id", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "security_incidents_agent_id_detected_at_idx" ON "security_incidents"("agent_id", "detected_at");

-- CreateIndex
CREATE INDEX "security_incidents_severity_detected_at_idx" ON "security_incidents"("severity", "detected_at");

-- CreateIndex
CREATE INDEX "threat_assessments_agent_id_created_at_idx" ON "threat_assessments"("agent_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_idempotency_key_key" ON "idempotency_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "idempotency_records_idempotency_key_idx" ON "idempotency_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "consumed_requests_agent_id_consumed_at_idx" ON "consumed_requests"("agent_id", "consumed_at");

-- CreateIndex
CREATE UNIQUE INDEX "consumed_requests_agent_id_request_id_key" ON "consumed_requests"("agent_id", "request_id");

-- CreateIndex
CREATE INDEX "audit_events_entity_id_created_at_idx" ON "audit_events"("entity_id", "created_at");

-- CreateIndex
CREATE INDEX "purchase_intents_agent_id_status_created_at_idx" ON "purchase_intents"("agent_id", "status", "created_at");
