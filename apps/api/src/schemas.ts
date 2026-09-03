// ============================================
// AgentBridge - Request Schemas
// ============================================
// Every request body and query is parsed through one of these before any
// business logic runs. Unknown keys are stripped, not merged, and numeric
// ranges are bounded — the negative-quantity bypass found in the Phase 0
// audit is rejected here, and again by a database CHECK constraint beneath.

import { z } from 'zod';

/** A cuid-like or ULID-like opaque id. Bounded to stop pathological inputs. */
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'must be an opaque identifier');

/** Free text that will be stored and later shown to a human. */
const shortText = z.string().trim().max(500);

export const createPurchaseIntentSchema = z
  .object({
    productId: id,
    // The exact field that broke the system: a positive integer, capped.
    quantity: z.number().int().min(1).max(1000).default(1),
    agentReason: shortText.default(''),
  })
  .strict();

export const evaluateSchema = z.object({}).strict().optional().default({});

export const createOrderSchema = z.object({}).strict().optional().default({});

export const verifyPaymentSchema = z
  .object({
    providerPaymentId: z.string().min(1).max(128),
    signature: z.string().min(1).max(512),
  })
  .strict();

export const approvalDecisionSchema = z
  .object({
    token: z.string().min(16).max(256),
    approve: z.boolean(),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(256),
  })
  .strict();

export const productQuerySchema = z
  .object({
    query: z.string().trim().max(120).optional(),
    category: z.string().trim().max(120).optional(),
    maxPriceMinor: z.coerce.number().int().min(0).max(100_000_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const updatePolicySchema = z
  .object({
    maxTransactionMinor: z.number().int().min(0).max(100_000_000).optional(),
    maxDailyMinor: z.number().int().min(0).max(1_000_000_000).optional(),
    maxTransactionsPerDay: z.number().int().min(0).max(10_000).optional(),
    approvalThresholdMinor: z.number().int().min(0).max(100_000_000).optional(),
    allowedCategories: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    allowedCurrencies: z.array(z.enum(['INR'])).max(10).optional(),
    riskBlockThreshold: z.number().int().min(0).max(100).optional(),
    riskApprovalThreshold: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be supplied' })
  .refine(
    (v) =>
      v.riskApprovalThreshold === undefined ||
      v.riskBlockThreshold === undefined ||
      v.riskApprovalThreshold <= v.riskBlockThreshold,
    { message: 'riskApprovalThreshold must not exceed riskBlockThreshold' }
  );

export const paginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(64).optional(),
  })
  .strict();

export const auditQuerySchema = z
  .object({
    entityId: id.optional(),
    action: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
