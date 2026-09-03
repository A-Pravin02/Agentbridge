'use client';

import type { ReactNode } from 'react';

// ---- Decision & status colouring ----
// One place decides what a verdict looks like, so ALLOW is never green in one
// view and grey in another.

const DECISION_STYLES: Record<string, string> = {
  ALLOW: 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/30',
  COMPLETED: 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/30',
  AUTHORIZED: 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/30',
  REQUIRE_APPROVAL: 'bg-amber-500/12 text-amber-300 ring-amber-500/30',
  REQUIRES_APPROVAL: 'bg-amber-500/12 text-amber-300 ring-amber-500/30',
  APPROVED: 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/30',
  PENDING: 'bg-amber-500/12 text-amber-300 ring-amber-500/30',
  PAYMENT_PENDING: 'bg-sky-500/12 text-sky-300 ring-sky-500/30',
  PAYMENT_PROCESSING: 'bg-sky-500/12 text-sky-300 ring-sky-500/30',
  BLOCK: 'bg-rose-500/12 text-rose-300 ring-rose-500/30',
  BLOCKED: 'bg-rose-500/12 text-rose-300 ring-rose-500/30',
  DENIED: 'bg-rose-500/12 text-rose-300 ring-rose-500/30',
  FAILED: 'bg-rose-500/12 text-rose-300 ring-rose-500/30',
  QUARANTINED: 'bg-rose-500/12 text-rose-300 ring-rose-500/30',
  EXPIRED: 'bg-zinc-500/12 text-zinc-400 ring-zinc-500/30',
  CREATED: 'bg-zinc-500/12 text-zinc-300 ring-zinc-500/30',
  ACTIVE: 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/30',
};

export function Badge({ value, className = '' }: { value: string; className?: string }) {
  const style = DECISION_STYLES[value] ?? 'bg-zinc-500/12 text-zinc-300 ring-zinc-500/30';
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style} ${className}`}
    >
      {value.replace(/_/g, ' ')}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  right,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-zinc-800 bg-zinc-900/40 ${className}`}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneClass = {
    default: 'text-zinc-100',
    good: 'text-emerald-300',
    warn: 'text-amber-300',
    bad: 'text-rose-300',
  }[tone];
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const variants = {
    default: 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border-zinc-700',
    primary: 'bg-emerald-600 text-white hover:bg-emerald-500 border-emerald-600',
    danger: 'bg-rose-600/90 text-white hover:bg-rose-600 border-rose-600',
    ghost: 'bg-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 border-transparent',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${variants} ${className}`}
    >
      {children}
    </button>
  );
}

export function RiskMeter({ score, level }: { score: number; level: string }) {
  const colour =
    score >= 80 ? 'bg-rose-500' : score >= 60 ? 'bg-amber-500' : score >= 30 ? 'bg-sky-500' : 'bg-emerald-500';
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${Math.min(100, score)}%` }} />
      </div>
      <span className="text-xs tabular-nums text-zinc-400">
        {score}/100 <span className="text-zinc-600">{level}</span>
      </span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-zinc-500">{children}</p>;
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-rose-800/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
      {message}
    </div>
  );
}
