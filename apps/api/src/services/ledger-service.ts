// ============================================
// AgentBridge - Budget Ledger
// ============================================
//
// THE CONCURRENCY CONTROL POINT OF THE ENTIRE SYSTEM.
//
// The Phase 0 audit proved the old design let 8 concurrent requests authorize
// ₹2,394 against a ₹2,000/day cap, because every request read the same
// pre-state before any of them wrote. Recomputing `dailySpent` with a SELECT
// and then deciding in application code is unfixable by construction: there is
// always a window between the read and the write.
//
// The fix is to stop reading-then-deciding. A reservation is a SINGLE
// conditional UPDATE whose predicate is the limit itself:
//
//     UPDATE agent_daily_ledger
//        SET reserved_minor = reserved_minor + :amount,
//            txn_count      = txn_count + 1
//      WHERE agent_id = :agent AND day = :day
//        AND reserved_minor <= :dailyCap - :amount
//        AND txn_count       < :countCap
//
// The database evaluates the predicate and applies the increment atomically
// under a row lock it takes itself. Two concurrent callers cannot both match:
// whichever commits second sees the first one's increment. A result of zero
// rows updated means "this would have breached the limit" — the caller is
// refused. There is no window.
//
// This is correct on both SQLite and PostgreSQL and requires no explicit
// locking or non-default isolation level. It is also why the daily-limit
// invariant is a database guarantee rather than an application convention.

import { prisma, type Db, ledgerDay, isUniqueViolation } from '../db.js';
import type { Minor } from '@agentbridge/shared-types';

export interface ReservationRequest {
  agentId: string;
  amountMinor: Minor;
  dailyCapMinor: Minor;
  countCap: number;
  day?: string;
}

export type ReservationResult =
  | { ok: true; day: string; reservedAfterMinor: Minor; txnCountAfter: number }
  | {
      ok: false;
      day: string;
      reason: 'DAILY_LIMIT_EXCEEDED' | 'DAILY_COUNT_EXCEEDED';
      reservedMinor: Minor;
      txnCount: number;
      remainingMinor: Minor;
    };

async function ensureRow(db: Db, agentId: string, day: string) {
  const existing = await db.agentDailyLedger.findUnique({
    where: { agentId_day: { agentId, day } },
  });
  if (existing) return existing;
  try {
    return await db.agentDailyLedger.create({ data: { agentId, day } });
  } catch (error) {
    // Another request created it between our read and write — that is fine.
    if (isUniqueViolation(error)) {
      const row = await db.agentDailyLedger.findUnique({
        where: { agentId_day: { agentId, day } },
      });
      if (row) return row;
    }
    throw error;
  }
}

/**
 * Atomically reserves budget for one purchase.
 *
 * Returns `ok: false` when the reservation would breach either cap. The caller
 * must treat that as authoritative and refuse the purchase — it outranks any
 * advisory check the policy engine performed a moment earlier.
 */
export async function reserveBudget(
  request: ReservationRequest,
  db: Db = prisma
): Promise<ReservationResult> {
  const { agentId, amountMinor, dailyCapMinor, countCap } = request;
  const day = request.day ?? ledgerDay();

  await ensureRow(db, agentId, day);

  // A reservation larger than the entire cap can never succeed; short-circuit
  // so the predicate below is never given a negative bound.
  if (amountMinor > dailyCapMinor) {
    const row = await db.agentDailyLedger.findUnique({
      where: { agentId_day: { agentId, day } },
    });
    return {
      ok: false,
      day,
      reason: 'DAILY_LIMIT_EXCEEDED',
      reservedMinor: row?.reservedMinor ?? 0,
      txnCount: row?.txnCount ?? 0,
      remainingMinor: Math.max(0, dailyCapMinor - (row?.reservedMinor ?? 0)),
    };
  }

  const updated = await db.agentDailyLedger.updateMany({
    where: {
      agentId,
      day,
      // The limit IS the predicate. This is the whole mechanism.
      reservedMinor: { lte: dailyCapMinor - amountMinor },
      txnCount: { lt: countCap },
    },
    data: {
      reservedMinor: { increment: amountMinor },
      txnCount: { increment: 1 },
    },
  });

  const row = await db.agentDailyLedger.findUnique({
    where: { agentId_day: { agentId, day } },
  });

  if (updated.count === 1) {
    return {
      ok: true,
      day,
      reservedAfterMinor: row?.reservedMinor ?? amountMinor,
      txnCountAfter: row?.txnCount ?? 1,
    };
  }

  const reservedMinor = row?.reservedMinor ?? 0;
  const txnCount = row?.txnCount ?? 0;
  return {
    ok: false,
    day,
    // Distinguish which cap bit, for an accurate refusal reason.
    reason: txnCount >= countCap ? 'DAILY_COUNT_EXCEEDED' : 'DAILY_LIMIT_EXCEEDED',
    reservedMinor,
    txnCount,
    remainingMinor: Math.max(0, dailyCapMinor - reservedMinor),
  };
}

/**
 * Returns budget to the agent when a reservation does not become a payment
 * (denied approval, expiry, cancellation, failed payment).
 *
 * Guarded so the ledger can never go negative even if a release were somehow
 * issued twice; the CHECK constraint is the backstop beneath that.
 */
export async function releaseBudget(
  params: { agentId: string; day: string; amountMinor: Minor },
  db: Db = prisma
): Promise<boolean> {
  const { agentId, day, amountMinor } = params;
  const released = await db.agentDailyLedger.updateMany({
    where: {
      agentId,
      day,
      reservedMinor: { gte: amountMinor },
      txnCount: { gte: 1 },
    },
    data: {
      reservedMinor: { decrement: amountMinor },
      txnCount: { decrement: 1 },
    },
  });
  return released.count === 1;
}

/** Read-only snapshot for the policy engine's advisory check and the dashboard. */
export async function getUsage(
  agentId: string,
  day: string = ledgerDay(),
  db: Db = prisma
): Promise<{ reservedMinor: Minor; txnCount: number }> {
  const row = await db.agentDailyLedger.findUnique({
    where: { agentId_day: { agentId, day } },
  });
  return { reservedMinor: row?.reservedMinor ?? 0, txnCount: row?.txnCount ?? 0 };
}
