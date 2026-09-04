'use client';

// ============================================
// AgentBridge - Merchant Dashboard
// ============================================

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  formatMinor,
  getToken,
  setToken,
  onWaking,
  warmUp,
  ApiError,
  type AgentRow,
  type AuditRow,
  type DemoRun,
  type PendingApproval,
  type Policy,
  type SessionUser,
  type Stats,
  type TransactionRow,
} from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorBanner, RiskMeter, Stat } from '@/components/primitives';
import { TransactionTimeline } from '@/components/TransactionTimeline';

type Tab = 'overview' | 'transactions' | 'approvals' | 'agents' | 'policy' | 'audit' | 'console';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'agents', label: 'Agents' },
  { id: 'policy', label: 'Policy' },
  { id: 'audit', label: 'Audit' },
  { id: 'console', label: 'Attack console' },
];

export default function Dashboard() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');

  const [waking, setWaking] = useState(false);

  useEffect(() => onWaking(setWaking), []);

  useEffect(() => {
    // Begin waking the API immediately, so it is booting while the visitor is
    // still reading the sign-in screen rather than after they click.
    warmUp();

    if (!getToken()) {
      setChecking(false);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return <Shell><Empty>Checking session…</Empty></Shell>;
  }
  if (!user) {
    return <Login onSignedIn={setUser} waking={waking} />;
  }

  return (
    <Shell
      user={user}
      onSignOut={async () => {
        await api.logout().catch(() => undefined);
        setToken(null);
        setUser(null);
      }}
    >
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'border-emerald-500 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && <Overview />}
      {tab === 'transactions' && <Transactions />}
      {tab === 'approvals' && <Approvals />}
      {tab === 'agents' && <Agents />}
      {tab === 'policy' && <PolicyPanel />}
      {tab === 'audit' && <AuditPanel />}
      {tab === 'console' && <AttackConsole />}
    </Shell>
  );
}

// ---- Layout ----

function Shell({
  children,
  user,
  onSignOut,
}: {
  children: React.ReactNode;
  user?: SessionUser;
  onSignOut?: () => void;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-base font-semibold tracking-tight">AgentBridge</h1>
            <p className="text-xs text-zinc-500">The authorization layer for AI commerce</p>
          </div>
          {user && (
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-sm text-zinc-300">{user.email}</p>
                <p className="text-xs text-zinc-500">{user.role}</p>
              </div>
              <Button variant="ghost" onClick={onSignOut}>Sign out</Button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">{children}</main>
    </div>
  );
}

function Login({
  onSignedIn,
  waking,
}: {
  onSignedIn: (u: SessionUser) => void;
  waking: boolean;
}) {
  const [email, setEmail] = useState('owner@techkart.demo');
  const [password, setPassword] = useState('techkart-demo-2026');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.login(email, password);
      setToken(token);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="mx-auto mt-16 max-w-sm">
        <Card title="Merchant sign-in" subtitle="Approvals require an authenticated human.">
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
                required
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
                required
              />
            </label>
            {waking && (
              <div className="rounded-lg border border-amber-800/60 bg-amber-950/25 px-3 py-2 text-xs text-amber-200">
                Waking the API — it sleeps when idle on the free tier, so the first
                request can take up to 30 seconds. This retries automatically.
              </div>
            )}
            {error && !waking && <ErrorBanner message={error} />}
            <Button type="submit" variant="primary" disabled={busy} className="w-full">
              {busy ? (waking ? 'Waking the server…' : 'Signing in…') : 'Sign in'}
            </Button>
          </form>
        </Card>
      </div>
    </Shell>
  );
}

// ---- Data hook ----

function useResource<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Request failed'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(refresh, [refresh]);
  return { data, error, loading, refresh };
}

// ---- Tabs ----

function Overview() {
  const { data, error } = useResource<Stats>(() => api.stats());
  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Purchase intents" value={data.totalIntents} />
        <Stat label="Settled value" value={data.completedValueDisplay} tone="good" />
        <Stat
          label="Pending approvals"
          value={data.pendingApprovals}
          tone={data.pendingApprovals > 0 ? 'warn' : 'default'}
        />
        <Stat
          label="Security incidents (24h)"
          value={data.securityIncidents24h}
          tone={data.securityIncidents24h > 0 ? 'bad' : 'good'}
        />
      </div>

      <Card
        title="Audit chain"
        subtitle="Every security-relevant event is hash-chained and independently verifiable."
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-2xl font-semibold tabular-nums">
              {data.auditChain.totalEvents.toLocaleString()}
            </p>
            <p className="text-xs text-zinc-500">events recorded</p>
          </div>
          <span
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset ${
              data.auditChain.valid
                ? 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/30'
                : 'bg-rose-500/12 text-rose-300 ring-rose-500/30'
            }`}
          >
            {data.auditChain.valid ? 'Verified intact' : 'TAMPERING DETECTED'}
          </span>
        </div>
        {data.auditChain.reason && (
          <p className="mt-3 text-xs text-rose-300">{data.auditChain.reason}</p>
        )}
      </Card>

      <Card title="Decisions by state">
        <div className="flex flex-wrap gap-2">
          {Object.entries(data.byStatus).map(([status, count]) => (
            <span key={status} className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-1.5">
              <Badge value={status} />
              <span className="text-sm tabular-nums text-zinc-300">{count}</span>
            </span>
          ))}
          {Object.keys(data.byStatus).length === 0 && <Empty>No transactions yet.</Empty>}
        </div>
      </Card>
    </div>
  );
}

function Transactions() {
  const { data, error, refresh } = useResource<TransactionRow[]>(() => api.transactions());
  const [selected, setSelected] = useState<string | null>(null);

  if (selected) return <TransactionTimeline id={selected} onClose={() => setSelected(null)} />;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <Card
      title="Transactions"
      subtitle="Select a row to see exactly which rules ran and why the decision was made."
      right={<Button onClick={refresh}>Refresh</Button>}
    >
      {data.length === 0 ? (
        <Empty>No transactions yet. Run the attack console to generate some.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="pb-2 pr-4 font-medium">Time</th>
                <th className="pb-2 pr-4 font-medium">Agent</th>
                <th className="pb-2 pr-4 font-medium">Product</th>
                <th className="pb-2 pr-4 text-right font-medium">Amount</th>
                <th className="pb-2 pr-4 font-medium">Decision</th>
                <th className="pb-2 pr-4 font-medium">State</th>
                <th className="pb-2 font-medium">Risk</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {data.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className="cursor-pointer transition-colors hover:bg-zinc-900/60"
                >
                  <td className="py-2.5 pr-4 font-mono text-xs text-zinc-500">
                    {new Date(t.createdAt).toLocaleTimeString('en-GB', { hour12: false })}
                  </td>
                  <td className="py-2.5 pr-4 text-zinc-300">{t.agent.name}</td>
                  <td className="py-2.5 pr-4 text-zinc-300">{t.product.name}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-zinc-200">{t.amountDisplay}</td>
                  <td className="py-2.5 pr-4">{t.decision ? <Badge value={t.decision} /> : '—'}</td>
                  <td className="py-2.5 pr-4"><Badge value={t.status} /></td>
                  <td className="py-2.5">
                    {t.riskScore !== null ? <RiskMeter score={t.riskScore} level="" /> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Approvals() {
  const { data, error, refresh } = useResource<PendingApproval[]>(() => api.pendingApprovals());
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const decide = async (id: string, approve: boolean) => {
    const token = tokens[id];
    if (!token) {
      setMessage('Paste the one-time approval token issued to the agent.');
      return;
    }
    try {
      const result = await api.decideApproval(id, token, approve);
      setMessage(`Decision recorded: ${result.decision} → ${result.status}`);
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Decision failed');
    }
  };

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <div className="space-y-4">
      <Card
        title="Pending approvals"
        subtitle="Each decision is single-use, time-limited, and attributed to your account."
        right={<Button onClick={refresh}>Refresh</Button>}
      >
        {message && <p className="mb-4 text-sm text-amber-300">{message}</p>}
        {data.length === 0 ? (
          <Empty>Nothing awaiting approval.</Empty>
        ) : (
          <ul className="space-y-4">
            {data.map((a) => (
              <li key={a.approvalId} className="rounded-lg border border-zinc-800 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-100">
                      {a.product.name} · {a.amountDisplay}
                    </p>
                    <p className="mt-0.5 text-sm text-zinc-500">
                      {a.agent.name} · {a.product.category}
                    </p>
                    <p className="mt-2 text-sm italic text-zinc-400">&ldquo;{a.agentReason}&rdquo;</p>
                    <p className="mt-2 text-xs text-zinc-500">
                      Expires {new Date(a.expiresAt).toLocaleTimeString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="primary" onClick={() => decide(a.purchaseIntentId, true)}>Approve</Button>
                    <Button variant="danger" onClick={() => decide(a.purchaseIntentId, false)}>Deny</Button>
                  </div>
                </div>
                <input
                  placeholder="One-time approval token"
                  value={tokens[a.purchaseIntentId] ?? ''}
                  onChange={(e) => setTokens((p) => ({ ...p, [a.purchaseIntentId]: e.target.value }))}
                  className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-xs outline-none focus:border-emerald-600"
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-xs text-zinc-600">
        The token is returned to the agent once, at evaluation time, and is never shown to the model.
        Requiring it means possession of a link alone cannot approve a purchase.
      </p>
    </div>
  );
}

function Agents() {
  const { data, error, refresh } = useResource<AgentRow[]>(() => api.agents());
  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <div className="space-y-4">
      {data.map((agent) => {
        const cap = agent.permission?.maxDailyMinor ?? 0;
        const used = agent.usageToday.spentMinor;
        const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
        return (
          <Card
            key={agent.id}
            title={agent.name}
            subtitle={`Key ${agent.keyId} · Ed25519 — the server holds only the public key`}
            right={
              <div className="flex items-center gap-2">
                <Badge value={agent.status} />
                {agent.status === 'QUARANTINED' && (
                  <Button onClick={() => api.unquarantine(agent.id).then(refresh)}>
                    Release
                  </Button>
                )}
              </div>
            }
          >
            {agent.quarantineReason && (
              <p className="mb-4 rounded-lg border border-rose-900/50 bg-rose-950/25 px-3 py-2 text-sm text-rose-200">
                {agent.quarantineReason}
              </p>
            )}
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-zinc-500">Permission passport</p>
                {agent.permission ? (
                  <dl className="mt-2 space-y-1.5 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="text-zinc-500">Per transaction</dt>
                      <dd className="tabular-nums text-zinc-200">{agent.permission.maxTransactionDisplay}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-zinc-500">Per day</dt>
                      <dd className="tabular-nums text-zinc-200">{agent.permission.maxDailyDisplay}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-zinc-500">Transactions/day</dt>
                      <dd className="tabular-nums text-zinc-200">{agent.permission.maxTransactionsPerDay}</dd>
                    </div>
                    <div className="pt-1">
                      <dt className="text-zinc-500">Categories</dt>
                      <dd className="mt-1 flex flex-wrap gap-1">
                        {agent.permission.allowedCategories.map((c) => (
                          <span key={c} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">{c}</span>
                        ))}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-2 text-sm text-rose-300">No passport — this agent can do nothing.</p>
                )}
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-zinc-500">Today&apos;s budget</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {agent.usageToday.spentDisplay}
                  <span className="text-base font-normal text-zinc-500"> / {agent.permission?.maxDailyDisplay ?? '—'}</span>
                </p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={`h-full rounded-full ${pct > 90 ? 'bg-rose-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  {agent.usageToday.transactionCount} transactions · {formatMinor(agent.usageToday.remainingMinor)} remaining
                </p>
                <p className="mt-3 text-xs text-zinc-500">
                  Violations: {agent.securityViolationCount} ({agent.severeThreatCount} severe)
                </p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function PolicyPanel() {
  const { data, error, refresh } = useResource<Policy>(() => api.policy());
  const [draft, setDraft] = useState<Partial<Policy>>({});
  const [message, setMessage] = useState<string | null>(null);

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  const fields: Array<[keyof Policy, string, string]> = [
    ['maxTransactionMinor', 'Max per transaction', 'paise'],
    ['maxDailyMinor', 'Max per day', 'paise'],
    ['maxTransactionsPerDay', 'Transactions per day', 'count'],
    ['approvalThresholdMinor', 'Approval threshold', 'paise'],
    ['riskApprovalThreshold', 'Risk → approval', '0-100'],
    ['riskBlockThreshold', 'Risk → block', '0-100'],
  ];

  const save = async () => {
    try {
      await api.updatePolicy(draft);
      setDraft({});
      setMessage('Policy updated. The previous version was snapshotted for replay.');
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Update failed');
    }
  };

  return (
    <Card
      title={`Merchant policy — version ${data.version}`}
      subtitle="Changing a policy snapshots the old version, so past decisions stay reproducible."
      right={<Button variant="primary" onClick={save} disabled={Object.keys(draft).length === 0}>Save</Button>}
    >
      {message && <p className="mb-4 text-sm text-emerald-300">{message}</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map(([key, label, unit]) => {
          const current = data[key] as number;
          const value = (draft[key] as number | undefined) ?? current;
          return (
            <label key={String(key)} className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
              <input
                type="number"
                value={value}
                onChange={(e) => setDraft((p) => ({ ...p, [key]: Number(e.target.value) }))}
                className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm tabular-nums outline-none focus:border-emerald-600"
              />
              <span className="mt-1 block text-xs text-zinc-600">
                {unit === 'paise' ? `${formatMinor(value)} (${unit})` : unit}
              </span>
            </label>
          );
        })}
      </div>
      <div className="mt-5 border-t border-zinc-800 pt-4">
        <p className="text-xs uppercase tracking-wide text-zinc-500">Allowed categories</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.allowedCategories.map((c) => (
            <span key={c} className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">{c}</span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function AuditPanel() {
  const { data, error, refresh } = useResource<AuditRow[]>(() => api.auditEvents());
  const [verification, setVerification] = useState<string | null>(null);

  const verify = async () => {
    const result = await api.verifyAudit();
    setVerification(
      result.valid
        ? `Chain verified: ${result.totalEvents} events, no gaps or modifications.`
        : `TAMPERING DETECTED — ${result.breakReason}: ${result.reason}`
    );
  };

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Empty>Loading…</Empty>;

  return (
    <Card
      title="Audit log"
      subtitle="Append-only and hash-chained. Verification recomputes every digest."
      right={
        <div className="flex gap-2">
          <Button onClick={verify}>Verify chain</Button>
          <Button onClick={refresh}>Refresh</Button>
        </div>
      }
    >
      {verification && (
        <p
          className={`mb-4 rounded-lg px-3 py-2 text-sm ${
            verification.startsWith('Chain verified')
              ? 'bg-emerald-500/10 text-emerald-300'
              : 'bg-rose-500/10 text-rose-300'
          }`}
        >
          {verification}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="pb-2 pr-4 font-medium">#</th>
              <th className="pb-2 pr-4 font-medium">Time</th>
              <th className="pb-2 pr-4 font-medium">Action</th>
              <th className="pb-2 pr-4 font-medium">Actor</th>
              <th className="pb-2 font-medium">Hash</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900">
            {data.map((e) => (
              <tr key={e.sequence}>
                <td className="py-2 pr-4 font-mono text-xs tabular-nums text-zinc-600">{e.sequence}</td>
                <td className="py-2 pr-4 font-mono text-xs text-zinc-500">
                  {new Date(e.timestamp).toLocaleTimeString('en-GB', { hour12: false })}
                </td>
                <td className="py-2 pr-4 text-zinc-300">{e.action.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="py-2 pr-4 text-xs text-zinc-500">{e.actorType.toLowerCase()} · {e.actorId}</td>
                <td className="py-2 font-mono text-xs text-zinc-700">{e.hash.slice(0, 20)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AttackConsole() {
  const [run, setRun] = useState<DemoRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resetDemo();
      setRun(await api.runDemo());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Console run failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card
        title="Live attack console"
        subtitle="Every scenario issues real signed requests through the real stack. Nothing is simulated."
        right={
          <Button variant="primary" onClick={execute} disabled={busy}>
            {busy ? 'Running…' : 'Run all scenarios'}
          </Button>
        }
      >
        {error && <ErrorBanner message={error} />}
        {!run && !error && (
          <Empty>
            Run the console to attack AgentBridge with forged payments, replayed requests,
            tampered bodies, concurrent spending and audit tampering — and watch each one fail.
          </Empty>
        )}

        {run && (
          <>
            <div className="mb-5 grid gap-4 sm:grid-cols-2">
              <Stat
                label="Scenarios passed"
                value={`${run.summary.passed} / ${run.summary.total}`}
                tone={run.summary.passed === run.summary.total ? 'good' : 'bad'}
              />
              <Stat
                label="Attacks stopped"
                value={`${run.summary.attacksStopped} / ${run.summary.attacksAttempted}`}
                tone={run.summary.attacksStopped === run.summary.attacksAttempted ? 'good' : 'bad'}
              />
            </div>

            <ul className="space-y-2">
              {run.results.map((r) => (
                <li
                  key={r.id}
                  className={`rounded-lg border px-4 py-3 ${
                    r.passed ? 'border-zinc-800 bg-zinc-950/40' : 'border-rose-900/60 bg-rose-950/25'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {r.attack && (
                          <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-300">
                            attack
                          </span>
                        )}
                        <span className="text-sm font-medium text-zinc-100">{r.title}</span>
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">{r.description}</p>
                      <p className="mt-1.5 font-mono text-xs text-zinc-400">{r.detail}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ring-1 ring-inset ${
                        r.passed
                          ? 'bg-emerald-500/12 text-emerald-300 ring-emerald-500/30'
                          : 'bg-rose-500/12 text-rose-300 ring-rose-500/30'
                      }`}
                    >
                      {r.passed ? (r.attack ? 'STOPPED' : 'AS EXPECTED') : 'FAILED'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
