'use client';

// ============================================
// Transaction Timeline
// ============================================
// The screen that answers "why did this happen?".
//
// It shows the full rule trace — including the checks that PASSED — because the
// interesting question for a merchant is rarely "what blocked this" but "what
// was actually considered". Every row is reconstructed from the hash-chained
// audit log, and the chain's integrity for this transaction is verified and
// displayed alongside it.

import { useEffect, useState } from 'react';
import { api, type Timeline } from '@/lib/api';
import { Badge, Card, Empty, ErrorBanner, RiskMeter } from './primitives';

const ACTION_LABELS: Record<string, string> = {
  PURCHASE_INTENT_CREATED: 'Agent proposed a purchase',
  POLICY_EVALUATED: 'Policy engine evaluated the request',
  THREAT_ANALYSIS_COMPLETED: 'Behavioural risk assessed',
  BUDGET_RESERVED: 'Daily budget reserved atomically',
  BUDGET_RELEASED: 'Daily budget released',
  PURCHASE_ALLOWED: 'Authorized',
  PURCHASE_BLOCKED: 'Blocked',
  APPROVAL_REQUESTED: 'Human approval requested',
  APPROVAL_GRANTED: 'Human approved',
  APPROVAL_DENIED: 'Human denied',
  PAYMENT_ORDER_CREATED: 'Payment order created',
  PAYMENT_VERIFIED: 'Payment signature verified',
  PAYMENT_VERIFICATION_FAILED: 'Payment signature REJECTED',
  TRANSACTION_COMPLETED: 'Transaction completed',
  HIGH_THREAT_DETECTED: 'High risk detected',
  CRITICAL_THREAT_DETECTED: 'Critical risk detected',
  AGENT_QUARANTINED: 'Agent quarantined',
};

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(new Date(iso).getMilliseconds()).padStart(3, '0');
}

export function TransactionTimeline({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .timeline(id)
      .then((t) => active && setData(t))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [id]);

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Empty>Loading timeline…</Empty>;

  const { intent, decision, risk, payment, timeline, integrity } = data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={onClose} className="text-sm text-zinc-400 hover:text-zinc-100">
          ← Back to transactions
        </button>
        <code className="text-xs text-zinc-600">{intent.id}</code>
      </div>

      {/* ---- Summary ---- */}
      <Card>
        <div className="grid gap-6 sm:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-zinc-500">Request</p>
              <p className="mt-1 text-lg font-semibold text-zinc-100">
                {intent.agent.name} → {intent.product.name} × {intent.quantity}
              </p>
              <p className="mt-0.5 text-sm text-zinc-400">
                {intent.amountDisplay} · {intent.product.category}
              </p>
            </div>
            {intent.agentReason && (
              <div>
                <p className="text-xs uppercase tracking-wide text-zinc-500">Agent&apos;s stated reason</p>
                {/* Untrusted text authored by the agent — rendered as data. */}
                <p className="mt-1 text-sm italic text-zinc-400">&ldquo;{intent.agentReason}&rdquo;</p>
              </div>
            )}
          </div>
          <div className="space-y-3 sm:text-right">
            <div>
              <p className="text-xs uppercase tracking-wide text-zinc-500">Outcome</p>
              <div className="mt-1.5 flex gap-2 sm:justify-end">
                {decision && <Badge value={decision.decision} />}
                <Badge value={intent.status} />
              </div>
            </div>
            {risk && (
              <div>
                <p className="text-xs uppercase tracking-wide text-zinc-500">Risk</p>
                <div className="mt-1.5 sm:flex sm:justify-end">
                  <RiskMeter score={risk.score} level={risk.level} />
                </div>
              </div>
            )}
          </div>
        </div>

        {decision && (
          <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-3">
            <p className="text-sm text-zinc-200">{decision.reason}</p>
            <p className="mt-1.5 font-mono text-xs text-zinc-500">
              {decision.reasonCode} · policy v{decision.policyVersion} · decision {decision.decisionId.slice(0, 8)}
            </p>
          </div>
        )}
      </Card>

      {/* ---- The rule trace ---- */}
      {decision && decision.evaluatedRules.length > 0 && (
        <Card
          title="Policy evaluation"
          subtitle={`All ${decision.evaluatedRules.length} rules, in evaluation order. The verdict is the most restrictive outcome.`}
        >
          <ul className="space-y-1.5">
            {decision.evaluatedRules.map((rule) => (
              <li
                key={rule.rule}
                className={`flex items-start gap-3 rounded-lg px-3 py-2 ${
                  rule.passed ? 'bg-zinc-950/40' : 'bg-rose-950/25 ring-1 ring-inset ring-rose-900/40'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    rule.passed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                  }`}
                >
                  {rule.passed ? '✓' : '✕'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs text-zinc-500">{rule.rule}</p>
                  <p className={`mt-0.5 text-sm ${rule.passed ? 'text-zinc-400' : 'text-rose-200'}`}>
                    {rule.message}
                  </p>
                </div>
                {!rule.passed && <Badge value={rule.outcome} className="shrink-0" />}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ---- Risk factors ---- */}
      {risk && risk.factors.length > 0 && (
        <Card title="Risk factors" subtitle="Transparent, rule-based signals — no model, no black box.">
          <ul className="space-y-2">
            {risk.factors.map((f, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5 shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-xs text-amber-300">
                  +{f.points}
                </span>
                <span className="text-zinc-300">{f.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ---- Payment ---- */}
      {payment && (
        <Card title="Payment" subtitle="Settlement requires a provider signature; nothing else can complete a purchase.">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 sm:contents">
              <dt className="text-zinc-500">Status</dt>
              <dd><Badge value={payment.status} /></dd>
            </div>
            <div className="flex justify-between gap-4 sm:contents">
              <dt className="text-zinc-500">Provider order</dt>
              <dd className="font-mono text-xs text-zinc-300">{payment.providerOrderId}</dd>
            </div>
            {payment.providerPaymentId && (
              <div className="flex justify-between gap-4 sm:contents">
                <dt className="text-zinc-500">Provider payment</dt>
                <dd className="font-mono text-xs text-zinc-300">{payment.providerPaymentId}</dd>
              </div>
            )}
            {payment.verifiedAt && (
              <div className="flex justify-between gap-4 sm:contents">
                <dt className="text-zinc-500">Verified at</dt>
                <dd className="text-zinc-300">{new Date(payment.verifiedAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>
        </Card>
      )}

      {/* ---- Audit trail ---- */}
      <Card
        title="Audit trail"
        subtitle="Every entry is hash-chained. Editing one breaks verification."
        right={
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${
              integrity.valid
                ? 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/30'
                : 'bg-rose-500/12 text-rose-300 ring-rose-500/30'
            }`}
          >
            {integrity.valid ? 'Chain verified' : 'TAMPERING DETECTED'}
          </span>
        }
      >
        {timeline.length === 0 ? (
          <Empty>No audit events recorded.</Empty>
        ) : (
          <ol className="relative space-y-0">
            {timeline.map((event, i) => (
              <li key={event.sequence} className="relative flex gap-4 pb-5 last:pb-0">
                {i < timeline.length - 1 && (
                  <span className="absolute left-[5px] top-4 h-full w-px bg-zinc-800" aria-hidden />
                )}
                <span className="relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-zinc-600 ring-4 ring-zinc-900" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <time className="font-mono text-xs tabular-nums text-zinc-500">
                      {time(event.timestamp)}
                    </time>
                    <span className="text-sm font-medium text-zinc-200">
                      {ACTION_LABELS[event.action] ?? event.action.replace(/_/g, ' ').toLowerCase()}
                    </span>
                    <span className="text-xs text-zinc-600">
                      {event.actorType.toLowerCase()} · {event.actorId}
                    </span>
                  </div>
                  {Object.keys(event.metadata).length > 0 && (
                    <p className="mt-1 truncate font-mono text-xs text-zinc-600">
                      {JSON.stringify(event.metadata)}
                    </p>
                  )}
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-700">
                    #{event.sequence} · {event.hash.slice(0, 16)}…
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
