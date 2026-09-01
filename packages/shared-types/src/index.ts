// ============================================
// AgentBridge - Shared Domain Types
// The Authorization Layer for AI Commerce
// ============================================

// ---- Purchase State Machine ----

export enum PurchaseStatus {
  CREATED = 'CREATED',
  EVALUATING = 'EVALUATING',
  AUTHORIZED = 'AUTHORIZED',
  REQUIRE_APPROVAL = 'REQUIRE_APPROVAL',
  APPROVED = 'APPROVED',
  DENIED = 'DENIED',
  BLOCKED = 'BLOCKED',
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  PAYMENT_PROCESSING = 'PAYMENT_PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

// ---- Policy Decision ----

export enum PolicyDecision {
  ALLOW = 'ALLOW',
  REQUIRE_APPROVAL = 'REQUIRE_APPROVAL',
  BLOCK = 'BLOCK',
}

// ---- Policy Violation Rules ----

export enum ViolationRule {
  MAX_TRANSACTION_AMOUNT = 'MAX_TRANSACTION_AMOUNT',
  MAX_DAILY_AMOUNT = 'MAX_DAILY_AMOUNT',
  MAX_TRANSACTIONS_PER_DAY = 'MAX_TRANSACTIONS_PER_DAY',
  CATEGORY_NOT_ALLOWED = 'CATEGORY_NOT_ALLOWED',
  AGENT_PERMISSION_INVALID = 'AGENT_PERMISSION_INVALID',
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  AGENT_INACTIVE = 'AGENT_INACTIVE',
  AGENT_EXPIRED = 'AGENT_EXPIRED',
  PRODUCT_OUT_OF_STOCK = 'PRODUCT_OUT_OF_STOCK',
  APPROVAL_THRESHOLD_EXCEEDED = 'APPROVAL_THRESHOLD_EXCEEDED',
}

// ---- Audit Event Actions ----

export enum AuditAction {
  PRODUCT_SEARCHED = 'PRODUCT_SEARCHED',
  PRODUCT_SELECTED = 'PRODUCT_SELECTED',
  PURCHASE_INTENT_CREATED = 'PURCHASE_INTENT_CREATED',
  AGENT_PERMISSION_CHECKED = 'AGENT_PERMISSION_CHECKED',
  POLICY_EVALUATED = 'POLICY_EVALUATED',
  PURCHASE_ALLOWED = 'PURCHASE_ALLOWED',
  PURCHASE_BLOCKED = 'PURCHASE_BLOCKED',
  APPROVAL_REQUESTED = 'APPROVAL_REQUESTED',
  APPROVAL_GRANTED = 'APPROVAL_GRANTED',
  APPROVAL_DENIED = 'APPROVAL_DENIED',
  PAYMENT_ORDER_CREATED = 'PAYMENT_ORDER_CREATED',
  PAYMENT_VERIFIED = 'PAYMENT_VERIFIED',
  TRANSACTION_COMPLETED = 'TRANSACTION_COMPLETED',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  // ---- Security Audit Actions ----
  SECURITY_VIOLATION_DETECTED = 'SECURITY_VIOLATION_DETECTED',
  REQUEST_BLOCKED_SECURITY = 'REQUEST_BLOCKED_SECURITY',
  REPLAY_ATTACK_DETECTED = 'REPLAY_ATTACK_DETECTED',
  IDEMPOTENCY_CONFLICT_DETECTED = 'IDEMPOTENCY_CONFLICT_DETECTED',
  POLICY_PROBING_DETECTED = 'POLICY_PROBING_DETECTED',
  THREAT_ANALYSIS_COMPLETED = 'THREAT_ANALYSIS_COMPLETED',
  HIGH_THREAT_DETECTED = 'HIGH_THREAT_DETECTED',
  CRITICAL_THREAT_DETECTED = 'CRITICAL_THREAT_DETECTED',
  AGENT_QUARANTINED = 'AGENT_QUARANTINED',
  AGENT_UNQUARANTINED = 'AGENT_UNQUARANTINED',
  AGENT_BLOCKED_PERMANENT = 'AGENT_BLOCKED_PERMANENT',
  AGENT_SECURITY_REVIEWED = 'AGENT_SECURITY_REVIEWED',
}

// ---- Actor Types for Audit ----

export enum ActorType {
  AGENT = 'AGENT',
  SYSTEM = 'SYSTEM',
  MERCHANT = 'MERCHANT',
  PAYMENT_PROVIDER = 'PAYMENT_PROVIDER',
}

// ---- Entity Status ----

export enum EntityStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

// ---- Approval Status ----

export enum ApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  DENIED = 'DENIED',
}

// ---- Payment Status ----

export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

// ---- Core Domain Interfaces ----

export interface Merchant {
  id: string;
  name: string;
  status: EntityStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Product {
  id: string;
  merchantId: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  stock: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Agent {
  id: string;
  merchantId: string;
  name: string;
  status: EntityStatus;
  createdAt: Date;
}

// ---- Agent Permission Passport ----

export interface AgentPermission {
  id: string;
  agentId: string;
  canSearch: boolean;
  canCreatePurchaseIntent: boolean;
  canExecutePurchase: boolean;
  allowedCategories: string[];
  maxTransactionAmount: number;
  maxDailyAmount: number;
  expiresAt: Date | null;
}

// ---- Merchant Policy ----

export interface MerchantPolicy {
  id: string;
  merchantId: string;
  maxTransactionAmount: number;
  maxDailyAmount: number;
  maxTransactionsPerDay: number;
  allowedCategories: string[];
  approvalThreshold: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Purchase Intent ----

export interface PurchaseIntent {
  id: string;
  merchantId: string;
  agentId: string;
  productId: string;
  quantity: number;
  amount: number;
  status: PurchaseStatus;
  agentReason: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Authorization ----

export interface Authorization {
  id: string;
  purchaseIntentId: string;
  decision: PolicyDecision;
  reasons: string[];
  policySnapshot: PolicySnapshot;
  expiresAt: Date;
  createdAt: Date;
}

// ---- Approval ----

export interface Approval {
  id: string;
  purchaseIntentId: string;
  status: ApprovalStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

// ---- Transaction ----

export interface Transaction {
  id: string;
  purchaseIntentId: string;
  amount: number;
  currency: string;
  paymentProvider: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  status: PaymentStatus;
  createdAt: Date;
  updatedAt: Date;
}

// ---- Audit Event ----

export interface AuditEvent {
  id: string;
  action: AuditAction;
  actorType: ActorType;
  actorId: string;
  entityId: string;
  metadata: Record<string, unknown>;
  previousHash: string;
  hash: string;
  createdAt: Date;
}

// ---- Policy Engine Types ----

export interface PurchaseRequest {
  merchantId: string;
  agentId: string;
  productId: string;
  productCategory: string;
  amount: number;
  currency: string;
  quantity: number;
  agentReason: string;
}

export interface AgentPolicy {
  agentPermission: AgentPermission;
  merchantPolicy: MerchantPolicy;
}

export interface PolicyContext {
  request: PurchaseRequest;
  policy: AgentPolicy;
  dailySpent: number;
  dailyTransactionCount: number;
}

export interface PolicyViolation {
  rule: ViolationRule;
  message: string;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reasons: string[];
  violations: PolicyViolation[];
}

// ---- Policy Snapshot (for audit) ----

export interface PolicySnapshot {
  maxTransactionAmount: number;
  maxDailyAmount: number;
  maxTransactionsPerDay: number;
  allowedCategories: string[];
  approvalThreshold: number;
  agentMaxTransaction: number;
  agentMaxDaily: number;
  agentAllowedCategories: string[];
}

// ---- Payment Provider Interface ----

export interface CreateOrderInput {
  amount: number;
  currency: string;
  purchaseIntentId: string;
  productName: string;
  merchantName: string;
}

export interface CreateOrderResult {
  providerOrderId: string;
  amount: number;
  currency: string;
  status: string;
}

export interface VerifyPaymentInput {
  providerOrderId: string;
  providerPaymentId: string;
  providerSignature: string;
}

export interface VerifyPaymentResult {
  verified: boolean;
  providerPaymentId: string;
  providerOrderId: string;
}

export interface PaymentProvider {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
  getPaymentStatus(providerOrderId: string): Promise<string>;
}

// ---- State Machine Types ----

export const VALID_TRANSITIONS: Record<PurchaseStatus, PurchaseStatus[]> = {
  [PurchaseStatus.CREATED]: [PurchaseStatus.EVALUATING],
  [PurchaseStatus.EVALUATING]: [
    PurchaseStatus.AUTHORIZED,
    PurchaseStatus.REQUIRE_APPROVAL,
    PurchaseStatus.BLOCKED,
  ],
  [PurchaseStatus.AUTHORIZED]: [PurchaseStatus.PAYMENT_PENDING],
  [PurchaseStatus.REQUIRE_APPROVAL]: [
    PurchaseStatus.APPROVED,
    PurchaseStatus.DENIED,
  ],
  [PurchaseStatus.APPROVED]: [PurchaseStatus.AUTHORIZED],
  [PurchaseStatus.DENIED]: [],
  [PurchaseStatus.BLOCKED]: [],
  [PurchaseStatus.PAYMENT_PENDING]: [
    PurchaseStatus.PAYMENT_PROCESSING,
    PurchaseStatus.FAILED,
    PurchaseStatus.EXPIRED,
  ],
  [PurchaseStatus.PAYMENT_PROCESSING]: [
    PurchaseStatus.COMPLETED,
    PurchaseStatus.FAILED,
  ],
  [PurchaseStatus.COMPLETED]: [],
  [PurchaseStatus.FAILED]: [],
  [PurchaseStatus.EXPIRED]: [],
};

// ---- API Response Types ----

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
}

// ============================================
// Security & Behavioral Threat Types
// Zero-Trust Agent Defense System
// ============================================

// ---- Agent Security Status ----

export enum AgentSecurityStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  QUARANTINED = 'QUARANTINED',
  BLOCKED = 'BLOCKED',
}

// ---- Threat Levels ----

export enum ThreatLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

// ---- Threat Recommended Actions ----

export enum ThreatAction {
  CONTINUE = 'CONTINUE',
  REQUIRE_APPROVAL = 'REQUIRE_APPROVAL',
  BLOCK_TRANSACTION = 'BLOCK_TRANSACTION',
  QUARANTINE_AGENT = 'QUARANTINE_AGENT',
}

// ---- Behavioral Threat Rules ----

export enum ThreatRule {
  HIGH_REQUEST_FREQUENCY = 'HIGH_REQUEST_FREQUENCY',
  EXTREME_REQUEST_FREQUENCY = 'EXTREME_REQUEST_FREQUENCY',
  REPEATED_BLOCKED_ATTEMPTS = 'REPEATED_BLOCKED_ATTEMPTS',
  EXCESSIVE_BLOCKED_ATTEMPTS = 'EXCESSIVE_BLOCKED_ATTEMPTS',
  REPEATED_POLICY_PROBING = 'REPEATED_POLICY_PROBING',
  REPEATED_NEAR_LIMIT_ATTEMPTS = 'REPEATED_NEAR_LIMIT_ATTEMPTS',
  UNUSUAL_SPENDING_SPIKE = 'UNUSUAL_SPENDING_SPIKE',
  RAPID_ESCALATION = 'RAPID_ESCALATION',
  SUSPICIOUS_CATEGORY_SWITCHING = 'SUSPICIOUS_CATEGORY_SWITCHING',
  REPEATED_DENIED_APPROVALS = 'REPEATED_DENIED_APPROVALS',
  MULTIPLE_SECURITY_WARNINGS = 'MULTIPLE_SECURITY_WARNINGS',
}

// ---- Confirmed Security Violations (Layer 1 - Immediate Block) ----

export enum SecurityViolation {
  UNKNOWN_AGENT = 'UNKNOWN_AGENT',
  INACTIVE_AGENT = 'INACTIVE_AGENT',
  INVALID_AUTHENTICATION = 'INVALID_AUTHENTICATION',
  INVALID_REQUEST_SIGNATURE = 'INVALID_REQUEST_SIGNATURE',
  EXPIRED_REQUEST = 'EXPIRED_REQUEST',
  REPLAY_ATTACK = 'REPLAY_ATTACK',
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
}

// ---- Quarantine Triggers ----

export enum QuarantineTrigger {
  AUTOMATIC_THREAT_DETECTION = 'AUTOMATIC_THREAT_DETECTION',
  SECURITY_VIOLATION = 'SECURITY_VIOLATION',
  MANUAL_ADMIN_ACTION = 'MANUAL_ADMIN_ACTION',
}

// ---- Severe Security Events (trigger escalation) ----

export const SEVERE_SECURITY_EVENTS: string[] = [
  SecurityViolation.REPLAY_ATTACK,
  SecurityViolation.IDEMPOTENCY_CONFLICT,
  SecurityViolation.INVALID_REQUEST_SIGNATURE,
  SecurityViolation.INVALID_STATE_TRANSITION,
  ThreatRule.EXTREME_REQUEST_FREQUENCY,
];

// ---- Threat Factor ----

export interface ThreatFactor {
  rule: string;
  points: number;
  message: string;
  metadata?: Record<string, unknown>;
}

// ---- Threat Assessment ----

export interface ThreatAssessmentResult {
  score: number;
  level: ThreatLevel;
  recommendedAction: ThreatAction;
  factors: ThreatFactor[];
  analyzedAt: Date;
}

// ---- Threat Context (pre-queried behavioral data) ----

export interface ThreatContext {
  agentId: string;
  currentAmount: number;
  currentCategory: string;
  agentMaxTransactionAmount: number;
  // Pre-queried behavioral data
  requestCountLast60Sec: number;
  blockedCountLast10Min: number;
  blockedCountLast30Min: number;
  deniedCountLast30Min: number;
  recentCompletedAmounts: number[];
  recentCategories: string[];
  recentPolicyFailures: { amount: number; category: string; createdAt: Date }[];
  recentPurchaseIntents: { amount: number; status: string; category: string; createdAt: Date }[];
}

// ---- Security Check Result ----

export interface SecurityCheckResult {
  passed: boolean;
  violation?: SecurityViolation;
  message: string;
}

// ---- Combined Decision (Decision Orchestrator output) ----

export interface CombinedDecision {
  finalDecision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'BLOCK';
  shouldQuarantine: boolean;
  reasons: string[];
  policyResult?: PolicyResult;
  threatAssessment?: ThreatAssessmentResult;
  securityViolation?: SecurityViolation;
}

