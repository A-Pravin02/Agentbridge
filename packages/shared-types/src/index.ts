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
