// ============================================
// AgentBridge - Shared Domain Types
// The Authorization Layer for AI Commerce
// ============================================

export * from './money.js';
export * from './enums.js';
export * from './policy.js';

import type { Minor } from './money.js';
import type { AgentStatus, PurchaseStatus, ApprovalStatus, PaymentStatus } from './enums.js';

// ---- Core entities (API-facing shapes; money always in minor units) ----

export interface Merchant {
  id: string;
  name: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Product {
  id: string;
  merchantId: string;
  name: string;
  description: string;
  priceMinor: Minor;
  currency: string;
  category: string;
  stock: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Agent {
  id: string;
  merchantId: string;
  name: string;
  status: AgentStatus;
  createdAt: Date;
}

export interface PurchaseIntent {
  id: string;
  merchantId: string;
  agentId: string;
  productId: string;
  quantity: number;
  amountMinor: Minor;
  currency: string;
  status: PurchaseStatus;
  agentReason: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Approval {
  id: string;
  purchaseIntentId: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface PaymentRecord {
  id: string;
  purchaseIntentId: string;
  amountMinor: Minor;
  currency: string;
  provider: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  status: PaymentStatus;
  createdAt: Date;
  updatedAt: Date;
}

// ---- API envelope ----

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiFailure {
  success: false;
  error: string;
  code?: string;
  /** Field-level validation problems, when applicable. */
  details?: Array<{ path: string; message: string }>;
  requestId?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
