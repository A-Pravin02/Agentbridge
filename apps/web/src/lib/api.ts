// ============================================
// AgentBridge - Dashboard API Client
// ============================================
// The dashboard authenticates as a MERCHANT USER with a session token.
//
// There is deliberately no admin key here. The Phase 0 audit found the previous
// build shipped `NEXT_PUBLIC_ADMIN_KEY` into the browser bundle, which made a
// privileged credential readable by anyone who opened devtools. The dashboard
// now holds only a short-lived session token obtained by logging in, and it can
// do exactly what that user's role permits.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const TOKEN_KEY = 'agentbridge.session';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — the session simply won't persist */
  }
}

// ---- Cold start handling ----
//
// The API is hosted on a free tier that sleeps after a period of inactivity, so
// the FIRST request after an idle spell can take ~30s while the container wakes.
// Without this, a visitor's first click just shows an error — the worst possible
// first impression for something whose whole point is reliability.
//
// So a request that fails in a way consistent with a sleeping server is retried
// with backoff, and the UI is told to explain what is happening rather than
// leaving a spinner to look like a hang.

type WakeListener = (waking: boolean) => void;
const wakeListeners = new Set<WakeListener>();
let isWaking = false;

/** Subscribe to cold-start state. Returns an unsubscribe function. */
export function onWaking(listener: WakeListener): () => void {
  wakeListeners.add(listener);
  listener(isWaking);
  return () => wakeListeners.delete(listener);
}

function setWaking(value: boolean) {
  if (isWaking === value) return;
  isWaking = value;
  wakeListeners.forEach((l) => l(value));
}

/** Statuses a sleeping or still-booting container produces. */
const COLD_START_STATUSES = new Set([502, 503, 504]);
const MAX_WAIT_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const started = Date.now();
  let attempt = 0;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
    } catch (networkError) {
      // Fetch itself failed — unreachable host, which is what a sleeping
      // service looks like from the browser.
      if (Date.now() - started < MAX_WAIT_MS) {
        setWaking(true);
        await sleep(Math.min(1000 * 2 ** attempt++, 5000));
        continue;
      }
      setWaking(false);
      throw new ApiError(0, 'Could not reach the API. It may still be starting up.');
    }

    if (COLD_START_STATUSES.has(res.status) && Date.now() - started < MAX_WAIT_MS) {
      setWaking(true);
      await sleep(Math.min(1000 * 2 ** attempt++, 5000));
      continue;
    }

    setWaking(false);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.code);
    }
    return body.data as T;
  }
}

/**
 * Fire-and-forget wake-up, called as soon as the page loads so the container
 * starts booting while the visitor is still reading the sign-in screen.
 */
export function warmUp(): void {
  fetch(`${API_URL}/api/health`).catch(() => undefined);
}

// ---- Types mirroring the API responses ----

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  merchantId: string;
}

export interface Stats {
  totalIntents: number;
  byStatus: Record<string, number>;
  completedValueMinor: number;
  completedValueDisplay: string;
  agents: number;
  pendingApprovals: number;
  securityIncidents24h: number;
  auditChain: { valid: boolean; totalEvents: number; reason?: string };
}

export interface TransactionRow {
  id: string;
  status: string;
  amountMinor: number;
  amountDisplay: string;
  product: { name: string; category: string };
  agent: { id: string; name: string };
  decision: string | null;
  reason: string | null;
  riskScore: number | null;
  paymentStatus: string | null;
  createdAt: string;
}

export interface EvaluatedRule {
  rule: string;
  outcome: string;
  passed: boolean;
  reasonCode: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface Timeline {
  intent: {
    id: string;
    status: string;
    amountDisplay: string;
    quantity: number;
    agentReason: string;
    product: { name: string; category: string; priceMinor: number };
    agent: { id: string; name: string };
  };
  decision: {
    decision: string;
    reasonCode: string;
    reason: string;
    policyVersion: number;
    decisionId: string;
    evaluatedRules: EvaluatedRule[];
  } | null;
  risk: { score: number; level: string; factors: Array<{ rule: string; points: number; message: string }> } | null;
  payment: {
    status: string;
    providerOrderId: string;
    providerPaymentId: string | null;
    verifiedAt: string | null;
  } | null;
  timeline: Array<{
    sequence: number;
    action: string;
    actorType: string;
    actorId: string;
    timestamp: string;
    metadata: Record<string, unknown>;
    hash: string;
  }>;
  integrity: { valid: boolean; reason?: string };
}

export interface PendingApproval {
  approvalId: string;
  purchaseIntentId: string;
  expiresAt: string;
  agent: { id: string; name: string };
  product: { id: string; name: string; category: string };
  amountMinor: number;
  amountDisplay: string;
  agentReason: string;
}

export interface AgentRow {
  id: string;
  name: string;
  status: string;
  keyId: string;
  quarantineReason: string | null;
  securityViolationCount: number;
  severeThreatCount: number;
  permission: {
    allowedCategories: string[];
    maxTransactionMinor: number;
    maxTransactionDisplay: string;
    maxDailyMinor: number;
    maxDailyDisplay: string;
    maxTransactionsPerDay: number;
  } | null;
  usageToday: {
    spentMinor: number;
    spentDisplay: string;
    transactionCount: number;
    remainingMinor: number;
  };
}

export interface Policy {
  id: string;
  version: number;
  maxTransactionMinor: number;
  maxDailyMinor: number;
  maxTransactionsPerDay: number;
  allowedCategories: string[];
  allowedCurrencies: string[];
  approvalThresholdMinor: number;
  riskBlockThreshold: number;
  riskApprovalThreshold: number;
}

export interface AuditRow {
  sequence: number;
  action: string;
  actorType: string;
  actorId: string;
  entityId: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  hash: string;
  previousHash: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  description: string;
  attack: boolean;
  expected: string;
  actual: string;
  detail: string;
  passed: boolean;
  durationMs: number;
}

export interface DemoRun {
  results: ScenarioResult[];
  summary: {
    total: number;
    passed: number;
    attacksAttempted: number;
    attacksStopped: number;
  };
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<unknown>('/api/auth/logout', { method: 'POST' }),
  me: () => request<SessionUser>('/api/auth/me'),

  stats: () => request<Stats>('/api/dashboard/stats'),
  transactions: () => request<TransactionRow[]>('/api/transactions'),
  timeline: (id: string) => request<Timeline>(`/api/transactions/${id}/timeline`),

  pendingApprovals: () => request<PendingApproval[]>('/api/approvals/pending'),
  decideApproval: (id: string, token: string, approve: boolean) =>
    request<{ decision: string; status: string }>(`/api/purchase-intents/${id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ token, approve }),
    }),

  agents: () => request<AgentRow[]>('/api/agents'),
  unquarantine: (id: string) =>
    request<unknown>(`/api/agents/${id}/unquarantine`, { method: 'POST', body: '{}' }),

  policy: () => request<Policy>('/api/policies'),
  updatePolicy: (patch: Partial<Policy>) =>
    request<Policy>('/api/policies', { method: 'PATCH', body: JSON.stringify(patch) }),

  auditEvents: () => request<AuditRow[]>('/api/audit/events?limit=100'),
  verifyAudit: () =>
    request<{ valid: boolean; totalEvents: number; reason?: string; breakReason?: string }>(
      '/api/audit/verify',
      { method: 'POST', body: '{}' }
    ),

  runDemo: () => request<DemoRun>('/api/demo/run', { method: 'POST', body: '{}' }),
  resetDemo: () => request<unknown>('/api/demo/reset', { method: 'POST', body: '{}' }),
};

/** Formats integer minor units for display: 29900 -> "₹299.00". */
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}₹${Math.floor(abs / 100).toLocaleString('en-IN')}.${String(abs % 100).padStart(2, '0')}`;
}
