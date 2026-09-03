// ============================================
// AgentBridge - Database Client
// ============================================

import { PrismaClient, Prisma } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __agentbridgePrisma?: PrismaClient };

export const prisma =
  globalForPrisma.__agentbridgePrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__agentbridgePrisma = prisma;
}

/** Any Prisma client or interactive-transaction handle. */
export type Db = PrismaClient | Prisma.TransactionClient;

// ---- JSON column helpers (SQLite has no array type) ----

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // Fail CLOSED: an unreadable allow-list grants nothing.
    return [];
  }
}

export function parseJsonObject<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The UTC calendar day key used by the budget ledger. */
export function ledgerDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True when an error is a Prisma unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

/** True when an error is a database CHECK/constraint failure. */
export function isConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2003' || error.code === 'P2004')
  );
}
