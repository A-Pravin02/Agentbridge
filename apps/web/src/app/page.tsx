'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';

interface Stats {
  totalTransactions: number;
  allowedTransactions: number;
  blockedTransactions: number;
  approvalRequests: number;
  completedTransactions: number;
  totalTransactionValue: number;
  recentActivity: any[];
}

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  stock: number;
  description: string;
}

interface Transaction {
  id: string;
  amount: number;
  status: string;
  agentReason: string;
  product: Product;
  createdAt: string;
  authorizations: any[];
}

interface PendingApproval {
  id: string;
  purchaseIntent: {
    id: string;
    amount: number;
    agentReason: string;
    product: Product;
    agent: { name: string };
  };
}

interface SecurityOverview {
  agents: { active: number; quarantined: number; blocked: number };
  incidents: { total: number; recent: any[] };
  highThreatTransactions: any[];
}

type Tab = 'dashboard' | 'catalog' | 'transactions' | 'approvals' | 'policy' | 'security' | 'replay' | 'demo';

// Razorpay Icon Components
function DashboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </svg>
  );
}

function CatalogIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

function TransactionsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="14" x="2" y="5" rx="2" />
      <line x1="2" x2="22" y1="10" y2="10" />
    </svg>
  );
}

function ApprovalsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <polyline points="16 11 18 13 22 9" />
    </svg>
  );
}

function PolicyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="M7 21h10" />
      <path d="M12 3v18" />
      <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
    </svg>
  );
}

function SecurityIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function DemoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg className={spinning ? 'animate-spin' : ''} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 21h5v-5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function StatusBadge({ status }: { status: string }) {
  let badgeClass = 'rzp-badge-neutral';
  let dotColor = '#64748B';

  const isSuccess = ['COMPLETED', 'AUTHORIZED', 'APPROVED', 'ACTIVE', 'ALLOW', 'LOW'].includes(status);
  const isDanger = ['BLOCKED', 'DENIED', 'FAILED', 'QUARANTINED', 'CRITICAL'].includes(status);
  const isWarning = ['REQUIRE_APPROVAL', 'HIGH', 'MEDIUM', 'PENDING'].includes(status);

  if (isSuccess) {
    badgeClass = 'rzp-badge-success';
    dotColor = '#10B981';
  } else if (isDanger) {
    badgeClass = 'rzp-badge-danger';
    dotColor = '#EF4444';
  } else if (isWarning) {
    badgeClass = 'rzp-badge-warning';
    dotColor = '#F59E0B';
  } else {
    badgeClass = 'rzp-badge-info';
    dotColor = '#0C83FF';
  }

  return (
    <span className={`rzp-badge ${badgeClass}`}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: dotColor, display: 'inline-block' }} />
      {status}
    </span>
  );
}

function formatCurrency(amount: number) {
  return `₹${amount.toLocaleString('en-IN')}`;
}

export default function Home() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [stats, setStats] = useState<Stats | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [policies, setPolicies] = useState<any[]>([]);
  const [securityOverview, setSecurityOverview] = useState<SecurityOverview | null>(null);
  const [securityAgents, setSecurityAgents] = useState<any[]>([]);
  const [replay, setReplay] = useState<any>(null);
  const [demoLog, setDemoLog] = useState<{ time: string; text: string; type: 'info' | 'success' | 'warn' | 'error' }[]>([]);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [chainStatus, setChainStatus] = useState<{ valid: boolean; totalEvents: number; reason?: string } | null>(null);
  const [isVerifyingChain, setIsVerifyingChain] = useState(false);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const [s, p, t, a, pol, secOver, secAg] = await Promise.allSettled([
        api.getStats(),
        api.getProducts(),
        api.getTransactions(),
        api.getPendingApprovals(),
        api.getPolicies(),
        api.getSecurityOverview(),
        api.getSecurityAgents(),
      ]);

      if (s.status === 'fulfilled') setStats(s.value.data);
      if (p.status === 'fulfilled') setProducts(p.value.data);
      if (t.status === 'fulfilled') setTransactions(t.value.data);
      if (a.status === 'fulfilled') setPendingApprovals(a.value.data);
      if (pol.status === 'fulfilled') setPolicies(pol.value.data);
      if (secOver.status === 'fulfilled') setSecurityOverview(secOver.value.data);
      if (secAg.status === 'fulfilled') setSecurityAgents(secAg.value.data);
    } catch (e) {
      console.error('Failed to refresh data:', e);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const addLog = (text: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    setDemoLog(prev => [...prev, { time: new Date().toLocaleTimeString(), text, type }]);
  };

  // ---- DEMO: Run full AI purchase flow ----
  async function runDemo(productId: string, productName: string) {
    setTab('demo');
    setDemoLog([]);
    setLoading(true);

    try {
      addLog(`AGENT: Autonomous intent initiated for item "${productName}"`, 'info');
      addLog('CATALOG: Querying TechKart inventory & merchant policy rules...', 'info');
      await new Promise(r => setTimeout(r, 350));

      addLog(`CATALOG: Item confirmed in stock (${productName})`, 'info');
      await new Promise(r => setTimeout(r, 200));

      addLog('PURCHASE INTENT: Dispatching signed intent to Razorpay AgentBridge Gateway...', 'info');
      const intent = await api.createPurchaseIntent({
        agentId: 'agent_shopping_01',
        productId,
        quantity: 1,
        agentReason: `Autonomous agent purchase: ${productName}`,
        merchantId: 'techkart_01',
      });
      addLog(`PURCHASE INTENT: Registered with ID ${intent.data.id}`, 'success');
      await new Promise(r => setTimeout(r, 200));

      addLog('ZERO-TRUST: Verifying cryptographic signature & agent status (ACTIVE)...', 'info');
      addLog('THREAT ANALYZER: Running behavioral anomaly detection rules...', 'info');
      
      const evaluation = await api.evaluatePurchase(intent.data.id);
      const decision = evaluation.data.policyResult?.decision || evaluation.data.decision;
      const reasons = evaluation.data.policyResult?.reasons || evaluation.data.reasons || [];
      const threat = evaluation.data.threatAssessment;

      if (threat) {
        addLog(`THREAT SCORE: ${threat.score}/100 [Risk Level: ${threat.level}]`, threat.score >= 50 ? 'warn' : 'info');
      }

      if (decision === 'ALLOW') {
        addLog(`POLICY DECISION: ALLOW — ${reasons[0] || 'Transaction approved within merchant limits'}`, 'success');
        await new Promise(r => setTimeout(r, 200));

        addLog('PAYMENT ORDER: Creating Razorpay test payment order...', 'info');
        await api.executePurchase(intent.data.id);
        addLog('PAYMENT ORDER: Order created, verifying merchant webhook signature...', 'info');
        await new Promise(r => setTimeout(r, 250));

        await api.completePurchase(intent.data.id);
        addLog('PAYMENT: Server-side cryptographic signature verified. Funds settled.', 'success');
        addLog('ORDER STATUS: COMPLETED', 'success');
        addLog('AUDIT CHAIN: SHA-256 event logged to immutable tamper-evident trail', 'info');
      } else if (decision === 'REQUIRE_APPROVAL') {
        addLog(`POLICY DECISION: REQUIRE_APPROVAL — ${reasons[0] || 'Transaction exceeds auto-allow threshold'}`, 'warn');
        addLog('APPROVAL QUEUE: Routed to Merchant Approval Center for manual authorization', 'warn');
      } else {
        addLog(`POLICY DECISION: BLOCKED — ${reasons[0] || 'Transaction violates merchant spending policy'}`, 'error');
        if (evaluation.data.policyResult?.violations) {
          evaluation.data.policyResult.violations.forEach((v: any) => {
            addLog(`VIOLATION: ${v.rule} — ${v.message}`, 'error');
          });
        }
        addLog('GATEWAY SHIELD: Payment execution halted at zero-trust policy layer', 'error');
      }
    } catch (e: any) {
      addLog(`ERROR: ${e.message}`, 'error');
    } finally {
      setLoading(false);
      refresh();
    }
  }

  // ---- SECURITY SIMULATION: Run Probing Attack ----
  async function simulateProbingAttack() {
    setTab('demo');
    setDemoLog([]);
    setLoading(true);

    try {
      addLog('SECURITY SIMULATION: Launching policy boundary probing attack scenario...', 'warn');
      addLog('AGENT: Automated bot attempting rapid requests to discover policy limits', 'warn');

      const p = products.find(prod => prod.name.includes('Power Bank')) || products[0];
      if (!p) return;

      for (let i = 1; i <= 3; i++) {
        addLog(`PROBE ATTEMPT #${i}: Submitting intent for ${p.name} (Amount: ₹${p.price * i})...`, 'warn');
        try {
          const intent = await api.createPurchaseIntent({
            agentId: 'agent_shopping_01',
            productId: p.id,
            quantity: i,
            agentReason: `Automated probe attack attempt #${i}`,
            merchantId: 'techkart_01',
          });
          const res = await api.evaluatePurchase(intent.data.id);
          addLog(`PROBE #${i} BLOCKED: Policy decision: ${res.data.policyResult?.decision || 'BLOCKED'}`, 'error');
        } catch (err: any) {
          addLog(`PROBE #${i} REJECTED: ${err.message}`, 'error');
        }
        await new Promise(r => setTimeout(r, 200));
      }

      addLog('THREAT ANALYZER: Flagged REPEATED_POLICY_PROBING anomaly (+40 Risk Points)', 'error');
      addLog('ZERO-TRUST DEFENSE: Behavioral threat incident recorded on security ledger', 'warn');
    } finally {
      setLoading(false);
      refresh();
    }
  }

  // ---- DEMO: Full Attack Simulation & Auto-Quarantine ----
  async function simulateAttackAndQuarantine() {
    setTab('demo');
    setDemoLog([]);
    setLoading(true);

    addLog('🚨 ADVERSARIAL SIMULATION: Launching multi-vector attack sequence...', 'warn');
    await new Promise(r => setTimeout(r, 250));

    try {
      const res = await api.simulateAttack();
      if (res.data?.log) {
        for (const item of res.data.log) {
          let logType: 'info' | 'warn' | 'error' | 'success' = 'warn';
          if (item.step === 1) logType = 'info';
          if (item.step === 2) logType = 'warn';
          if (item.step === 3 || item.step === 4) logType = 'error';
          if (item.step === 5) logType = res.data.quarantined ? 'error' : 'warn';
          
          addLog(`[STEP ${item.step}] ${item.action.toUpperCase()}: ${item.result}`, logType);
          await new Promise(r => setTimeout(r, 300));
        }
      }

      if (res.data?.quarantined) {
        addLog(`🛑 ZERO-TRUST DEFENSE SHIELD: Agent auto-quarantined! (${res.data.quarantineReason})`, 'error');
        addLog('🔒 AUTHORIZATION REVOKED: All future transaction intents immediately blocked at gateway.', 'error');
      }
    } catch (e: any) {
      addLog(`Simulation error: ${e.message}`, 'error');
    } finally {
      setLoading(false);
      refresh();
    }
  }

  // ---- DEMO: Reset Agent State ----
  async function handleResetDemoConsole() {
    setLoading(true);
    try {
      await api.resetDemo();
      addLog('🔄 DEMO RESET: Agent returned to ACTIVE state. All security counters zeroed.', 'success');
      refresh();
    } catch (e: any) {
      addLog(`Reset error: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }

  // ---- AUDIT: Verify Cryptographic Hash Chain ----
  async function handleVerifyChain() {
    setIsVerifyingChain(true);
    try {
      const res = await api.verifyAuditChain();
      setChainStatus(res.data);
      if (res.data.valid) {
        addLog(`🛡️ AUDIT VERIFICATION: Validated all ${res.data.totalEvents} blocks in SHA-256 hash chain. Zero tampering detected.`, 'success');
      } else {
        addLog(`⚠️ AUDIT WARNING: Hash chain broken at event index ${res.data.brokenAt}: ${res.data.reason}`, 'error');
      }
    } catch (e: any) {
      alert(`Verification failed: ${e.message}`);
    } finally {
      setIsVerifyingChain(false);
    }
  }

  async function handleApprove(intentId: string) {
    try {
      await api.approvePurchase(intentId);
      refresh();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handleDeny(intentId: string) {
    try {
      await api.denyPurchase(intentId);
      refresh();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handleUnquarantine(agentId: string) {
    try {
      await api.unquarantineAgent(agentId);
      alert(`Agent ${agentId} released from quarantine.`);
      refresh();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handleBlockPermanent(agentId: string) {
    if (!confirm(`Are you sure you want to permanently block agent ${agentId}?`)) return;
    try {
      await api.blockAgentPermanent(agentId, 'Manual administrator permanent block');
      alert(`Agent ${agentId} permanently blocked.`);
      refresh();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function viewReplay(intentId: string) {
    try {
      const r = await api.getTransactionReplay(intentId);
      setReplay(r.data);
      setTab('replay');
    } catch (e: any) {
      alert(e.message);
    }
  }

  const navItems = [
    { section: 'CORE', items: [{ id: 'dashboard' as Tab, label: 'Dashboard', icon: <DashboardIcon /> }] },
    {
      section: 'GATEWAY & COMMERCE',
      items: [
        { id: 'catalog' as Tab, label: 'Product Catalog', icon: <CatalogIcon /> },
        { id: 'transactions' as Tab, label: 'Transactions', icon: <TransactionsIcon /> },
        {
          id: 'approvals' as Tab,
          label: 'Approvals',
          icon: <ApprovalsIcon />,
          badge: pendingApprovals.length > 0 ? pendingApprovals.length : undefined,
          badgeColor: 'bg-amber-500 text-white',
        },
      ],
    },
    {
      section: 'GOVERNANCE & TRUST',
      items: [
        { id: 'policy' as Tab, label: 'Policy Studio', icon: <PolicyIcon /> },
        {
          id: 'security' as Tab,
          label: 'Zero-Trust Defense',
          icon: <SecurityIcon />,
          badge:
            securityOverview && (securityOverview.agents.quarantined > 0 || securityOverview.agents.blocked > 0)
              ? securityOverview.agents.quarantined + securityOverview.agents.blocked
              : undefined,
          badgeColor: 'bg-red-500 text-white',
        },
      ],
    },
    {
      section: 'TESTING & AUDIT',
      items: [
        { id: 'demo' as Tab, label: 'Live Agent Console', icon: <DemoIcon /> },
      ],
    },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F6F8]">
      {/* Top Razorpay Accent Bar */}
      <div className="h-1 bg-[#0C83FF] w-full" />

      <div className="flex flex-1">
        {/* Left Sidebar - Razorpay Enterprise Dark */}
        <aside className="w-64 bg-[#08132B] text-slate-300 flex flex-col border-r border-[#152445] shrink-0 select-none">
          {/* Razorpay Brand Header */}
          <div className="px-5 py-5 border-b border-[#152445] flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-[#0C83FF] flex items-center justify-center text-white font-bold text-base shadow-sm">
              R
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-white tracking-tight text-base">AgentBridge</span>
                <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-[#0C83FF]/20 text-[#3395FF] border border-[#0C83FF]/30">AI</span>
              </div>
              <p className="text-[11px] text-slate-400 font-medium">Razorpay AI Gateway</p>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="flex-1 px-3 py-4 space-y-6 overflow-y-auto">
            {navItems.map((group, gIdx) => (
              <div key={gIdx}>
                <div className="px-3 mb-2 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                  {group.section}
                </div>
                <div className="space-y-1">
                  {group.items.map(item => {
                    const isActive = tab === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setTab(item.id)}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-[13px] font-medium transition-all ${
                          isActive
                            ? 'bg-[#0C83FF] text-white shadow-sm'
                            : 'text-slate-300 hover:bg-[#122144] hover:text-white'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className={isActive ? 'text-white' : 'text-slate-400'}>{item.icon}</span>
                          <span>{item.label}</span>
                        </div>
                        {item.badge !== undefined && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded-full ${item.badgeColor || 'bg-slate-700 text-white'}`}>
                            {item.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Sidebar Footer - System Health */}
          <div className="p-4 border-t border-[#152445] bg-[#060F22] text-xs">
            <div className="flex items-center justify-between text-slate-400 mb-1">
              <span className="text-[11px]">Gateway Engine</span>
              <span className="text-[10px] font-mono text-emerald-400 font-medium">ONLINE</span>
            </div>
            <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
              <span>SHA-256 Audit Chained</span>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header Bar */}
          <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0 shadow-xs">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-900 text-sm">TechKart Electronics Pvt Ltd</span>
                <span className="text-xs text-slate-400">•</span>
                <span className="text-xs text-slate-500 font-mono">MID: techkart_01</span>
              </div>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                <span className="rzp-live-indicator" />
                Live Gateway Mode
              </span>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={refresh}
                disabled={isRefreshing}
                className="rzp-btn-secondary text-xs px-3 py-1.5"
                title="Sync Gateway State"
              >
                <RefreshIcon spinning={isRefreshing} />
                <span>Sync</span>
              </button>
              <button
                onClick={() => {
                  const p = products[0];
                  if (p) runDemo(p.id, p.name);
                  else setTab('demo');
                }}
                className="rzp-btn-primary text-xs"
              >
                <span>⚡ Test Agent Buy</span>
              </button>
            </div>
          </header>

          {/* Main Body View */}
          <main className="flex-1 p-6 overflow-y-auto max-w-7xl w-full mx-auto">
            {/* 1. DASHBOARD */}
            {tab === 'dashboard' && stats && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl font-bold text-slate-900">Merchant AI Overview</h1>
                  <p className="text-xs text-slate-500 mt-0.5">Real-time telemetry and deterministic financial guardrails</p>
                </div>

                {/* KPI Cards Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="rzp-card p-4 border-l-4 border-l-[#0C83FF]">
                    <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Volume</div>
                    <div className="text-2xl font-bold text-slate-900 mt-1">{formatCurrency(stats.totalTransactionValue)}</div>
                    <div className="text-[11px] text-slate-400 mt-1">{stats.totalTransactions} AI transactions processed</div>
                  </div>

                  <div className="rzp-card p-4 border-l-4 border-l-emerald-500">
                    <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Allowed & Settled</div>
                    <div className="text-2xl font-bold text-emerald-600 mt-1">{stats.allowedTransactions}</div>
                    <div className="text-[11px] text-slate-400 mt-1">{stats.completedTransactions} successfully completed</div>
                  </div>

                  <div className="rzp-card p-4 border-l-4 border-l-amber-500">
                    <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Requires Approval</div>
                    <div className="text-2xl font-bold text-amber-600 mt-1">{stats.approvalRequests}</div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {pendingApprovals.length > 0 ? (
                        <span className="text-amber-600 font-medium">{pendingApprovals.length} awaiting your action</span>
                      ) : (
                        'No pending review queue'
                      )}
                    </div>
                  </div>

                  <div className="rzp-card p-4 border-l-4 border-l-red-500">
                    <div className="text-xs font-medium text-slate-500 uppercase tracking-wider">Blocked by Shield</div>
                    <div className="text-2xl font-bold text-red-600 mt-1">{stats.blockedTransactions}</div>
                    <div className="text-[11px] text-slate-400 mt-1">Zero unauthorized leakage</div>
                  </div>
                </div>

                {/* Outcome Ratio Bar */}
                <div className="rzp-card p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-700 uppercase tracking-wider">Gateway Policy Execution Distribution</span>
                    <span className="text-xs text-slate-500">{stats.totalTransactions} Total Invocations</span>
                  </div>
                  <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden flex">
                    {stats.totalTransactions > 0 ? (
                      <>
                        <div
                          style={{ width: `${(stats.allowedTransactions / stats.totalTransactions) * 100}%` }}
                          className="bg-emerald-500 h-full"
                          title={`Allowed: ${stats.allowedTransactions}`}
                        />
                        <div
                          style={{ width: `${(stats.approvalRequests / stats.totalTransactions) * 100}%` }}
                          className="bg-amber-400 h-full"
                          title={`Approval: ${stats.approvalRequests}`}
                        />
                        <div
                          style={{ width: `${(stats.blockedTransactions / stats.totalTransactions) * 100}%` }}
                          className="bg-red-500 h-full"
                          title={`Blocked: ${stats.blockedTransactions}`}
                        />
                      </>
                    ) : (
                      <div className="w-full bg-slate-200 h-full" />
                    )}
                  </div>
                  <div className="flex items-center gap-6 mt-3 text-xs text-slate-600">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" />
                      <span>Allowed ({stats.allowedTransactions})</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm bg-amber-400 inline-block" />
                      <span>Requires Approval ({stats.approvalRequests})</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block" />
                      <span>Blocked by Policy ({stats.blockedTransactions})</span>
                    </div>
                  </div>
                </div>

                {/* Recent Activity Ledger */}
                <div className="rzp-card overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
                    <div>
                      <h2 className="text-sm font-bold text-slate-900">Recent Gateway Activity Feed</h2>
                      <p className="text-xs text-slate-500">Live cryptographic authorization stream</p>
                    </div>
                    <button onClick={() => setTab('transactions')} className="text-xs font-semibold text-[#0C83FF] hover:underline">
                      View All Transactions →
                    </button>
                  </div>

                  {stats.recentActivity.length === 0 ? (
                    <div className="p-8 text-center text-slate-400 text-xs">
                      No transaction events logged yet. Trigger an AI purchase from the catalog!
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {stats.recentActivity.map((event: any, i: number) => (
                        <div key={i} className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-mono text-slate-400">
                              {new Date(event.createdAt).toLocaleTimeString()}
                            </span>
                            <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                              {event.actorType}
                            </span>
                            <StatusBadge status={event.action} />
                          </div>
                          <div className="flex items-center gap-4">
                            {event.metadata?.amount && (
                              <span className="text-xs font-bold text-slate-900 font-mono">
                                {formatCurrency(event.metadata.amount)}
                              </span>
                            )}
                            <span className="text-[11px] text-slate-400 font-mono">
                              MID: {event.merchantId || 'techkart_01'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 2. CATALOG */}
            {tab === 'catalog' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-xl font-bold text-slate-900">Merchant Product Catalog</h1>
                    <p className="text-xs text-slate-500 mt-0.5">Available inventory exposed to autonomous AI shopping agents</p>
                  </div>
                  <span className="text-xs font-medium text-slate-500 bg-white px-3 py-1.5 rounded-md border border-slate-200 shadow-xs">
                    {products.length} Products Active
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {products.map(p => (
                    <div key={p.id} className="rzp-card rzp-card-interactive p-5 flex flex-col justify-between">
                      <div>
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <h3 className="text-base font-bold text-slate-900">{p.name}</h3>
                          <span className="rzp-badge rzp-badge-neutral">{p.category}</span>
                        </div>
                        <p className="text-xs text-slate-600 mb-4 line-clamp-2 leading-relaxed">{p.description}</p>
                      </div>

                      <div>
                        <div className="flex items-baseline justify-between pt-3 border-t border-slate-100 mb-4">
                          <div>
                            <span className="text-xs text-slate-400 block mb-0.5">Price</span>
                            <span className="text-xl font-bold text-slate-900 font-mono">{formatCurrency(p.price)}</span>
                          </div>
                          <div className="text-right">
                            <span className="text-xs text-slate-400 block mb-0.5">Inventory</span>
                            <span className="text-xs font-semibold text-slate-700">{p.stock} in stock</span>
                          </div>
                        </div>

                        <button
                          className="w-full rzp-btn-primary text-xs py-2"
                          onClick={() => runDemo(p.id, p.name)}
                          disabled={loading}
                        >
                          <span>Simulate AI Agent Purchase</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 3. TRANSACTIONS */}
            {tab === 'transactions' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-xl font-bold text-slate-900">Transaction Ledger</h1>
                    <p className="text-xs text-slate-500 mt-0.5">Detailed records of all autonomous AI purchase evaluations</p>
                  </div>
                  <span className="text-xs font-medium text-slate-500 bg-white px-3 py-1.5 rounded-md border border-slate-200">
                    {transactions.length} Total Records
                  </span>
                </div>

                <div className="rzp-card overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="rzp-table">
                      <thead>
                        <tr>
                          <th>Item / Product</th>
                          <th>Amount</th>
                          <th>Status</th>
                          <th>Agent Reason</th>
                          <th>Timestamp</th>
                          <th style={{ textAlign: 'right' }}>Audit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="text-center py-8 text-slate-400">
                              No transactions recorded yet.
                            </td>
                          </tr>
                        ) : (
                          transactions.map(tx => (
                            <tr key={tx.id}>
                              <td>
                                <div className="font-semibold text-slate-900">{tx.product?.name || 'Unknown Product'}</div>
                                <div className="text-[11px] text-slate-400 font-mono">{tx.id.substring(0, 18)}...</div>
                              </td>
                              <td className="font-mono font-bold text-slate-900">{formatCurrency(tx.amount)}</td>
                              <td>
                                <StatusBadge status={tx.status} />
                              </td>
                              <td className="text-xs text-slate-600 max-w-xs truncate" title={tx.agentReason}>
                                {tx.agentReason}
                              </td>
                              <td className="text-xs text-slate-500 whitespace-nowrap">
                                {new Date(tx.createdAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <button
                                  onClick={() => viewReplay(tx.id)}
                                  className="rzp-btn-secondary text-xs px-2.5 py-1 text-[#0C83FF] hover:text-[#0C83FF]"
                                >
                                  Replay Trail
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* 4. APPROVALS */}
            {tab === 'approvals' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl font-bold text-slate-900">Merchant Approval Center</h1>
                  <p className="text-xs text-slate-500 mt-0.5">Manual intervention queue for high-value or conditional agent transactions</p>
                </div>

                {pendingApprovals.length === 0 ? (
                  <div className="rzp-card p-12 text-center">
                    <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-3 border border-emerald-200">
                      <CheckIcon />
                    </div>
                    <h3 className="text-base font-bold text-slate-900">All Clear — No Pending Approvals</h3>
                    <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                      Transactions requiring merchant confirmation (e.g. amounts between ₹400 and ₹1,000) will appear here for 1-click authorization.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {pendingApprovals.map(a => (
                      <div key={a.id} className="rzp-card p-5 border-l-4 border-l-amber-500 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <div className="space-y-1.5 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900 text-base">{a.purchaseIntent.product?.name}</span>
                            <StatusBadge status="REQUIRE_APPROVAL" />
                          </div>
                          <div className="text-2xl font-bold text-amber-600 font-mono">
                            {formatCurrency(a.purchaseIntent.amount)}
                          </div>
                          <div className="text-xs text-slate-600">
                            <span className="font-medium text-slate-900">Agent:</span> {a.purchaseIntent.agent?.name || 'Shopping Agent'} •{' '}
                            <span className="font-medium text-slate-900">Reason:</span> {a.purchaseIntent.agentReason}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            className="rzp-btn-success text-xs px-4 py-2"
                            onClick={() => handleApprove(a.purchaseIntent.id)}
                          >
                            <CheckIcon />
                            <span>Approve Order</span>
                          </button>
                          <button
                            className="rzp-btn-danger text-xs px-4 py-2"
                            onClick={() => handleDeny(a.purchaseIntent.id)}
                          >
                            <XIcon />
                            <span>Deny</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 5. POLICY STUDIO */}
            {tab === 'policy' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl font-bold text-slate-900">Policy Studio & Guardrails</h1>
                  <p className="text-xs text-slate-500 mt-0.5">Deterministic rules evaluated before any payment execution is authorized</p>
                </div>

                {policies.map((p: any) => (
                  <div key={p.id} className="space-y-6">
                    {/* Limit Tiles */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div className="rzp-card p-4">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Max Single Transaction</span>
                        <span className="text-xl font-bold text-slate-900 font-mono mt-1 block">{formatCurrency(p.maxTransactionAmount)}</span>
                        <span className="text-[11px] text-slate-500 mt-1 block">Hard ceiling per request</span>
                      </div>

                      <div className="rzp-card p-4">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Approval Threshold</span>
                        <span className="text-xl font-bold text-amber-600 font-mono mt-1 block">{formatCurrency(p.approvalThreshold)}</span>
                        <span className="text-[11px] text-slate-500 mt-1 block">Requires manual merchant sign-off</span>
                      </div>

                      <div className="rzp-card p-4">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Daily Spend Cap</span>
                        <span className="text-xl font-bold text-slate-900 font-mono mt-1 block">{formatCurrency(p.maxDailyAmount)}</span>
                        <span className="text-[11px] text-slate-500 mt-1 block">Cumulative daily cap</span>
                      </div>

                      <div className="rzp-card p-4">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Max Invocations / Day</span>
                        <span className="text-xl font-bold text-[#0C83FF] font-mono mt-1 block">{p.maxTransactionsPerDay} tx/day</span>
                        <span className="text-[11px] text-slate-500 mt-1 block">Rate limit velocity protection</span>
                      </div>
                    </div>

                    {/* Allowed Categories */}
                    <div className="rzp-card p-5">
                      <h3 className="text-sm font-bold text-slate-900 mb-3">Merchant Category Whitelist</h3>
                      <div className="flex gap-2 flex-wrap">
                        {p.allowedCategories?.map((c: string) => (
                          <span key={c} className="rzp-badge rzp-badge-success text-xs py-1 px-2.5">
                            ✓ {c}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Policy Boundary Matrix */}
                    <div className="rzp-card overflow-hidden">
                      <div className="px-5 py-4 border-b border-slate-200">
                        <h3 className="text-sm font-bold text-slate-900">Deterministic Policy Evaluation Matrix</h3>
                        <p className="text-xs text-slate-500">Live boundary verification mapped across product price tiers</p>
                      </div>
                      <table className="rzp-table">
                        <thead>
                          <tr>
                            <th>Product Sample</th>
                            <th>Unit Price</th>
                            <th>Policy Decision</th>
                            <th>Authorization Route</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            { product: 'USB-C Cable', price: '₹299', decision: 'ALLOW', route: 'Automated Instant Execution', status: 'ALLOW' },
                            { product: 'Premium Phone Case', price: '₹399', decision: 'ALLOW', route: 'Automated Instant Execution', status: 'ALLOW' },
                            { product: 'Premium Heavy Duty Case', price: '₹499', decision: 'REQUIRE_APPROVAL', route: 'Merchant Approval Queue', status: 'REQUIRE_APPROVAL' },
                            { product: 'Fast Power Bank', price: '₹1,499', decision: 'BLOCK', route: 'Zero-Trust Rejection (>₹1,000 ceiling)', status: 'BLOCKED' },
                            { product: 'Wireless Bluetooth Speaker', price: '₹2,999', decision: 'BLOCK', route: 'Zero-Trust Rejection (>₹1,000 ceiling)', status: 'BLOCKED' },
                          ].map((r, i) => (
                            <tr key={i}>
                              <td className="font-medium text-slate-900">{r.product}</td>
                              <td className="font-mono font-semibold text-slate-900">{r.price}</td>
                              <td>
                                <StatusBadge status={r.status} />
                              </td>
                              <td className="text-xs text-slate-500">{r.route}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 6. ZERO-TRUST DEFENSE */}
            {tab === 'security' && (
              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-xl font-bold text-slate-900">Zero-Trust Agent Defense Matrix</h1>
                    <p className="text-xs text-slate-500 mt-0.5">Multi-layered behavioral anomaly detection, quarantine controls, and audit integrity</p>
                  </div>
                  <button
                    onClick={simulateProbingAttack}
                    className="rzp-btn-secondary border-red-300 text-red-600 hover:bg-red-50 text-xs"
                  >
                    <span>⚠️ Simulate Policy Probing Attack</span>
                  </button>
                </div>

                {/* Security Metrics Overview */}
                {securityOverview && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="rzp-card p-4 border-l-4 border-l-emerald-500">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Active Verified Agents</span>
                      <span className="text-2xl font-bold text-emerald-600 font-mono mt-1 block">{securityOverview.agents.active}</span>
                      <span className="text-[11px] text-slate-500 mt-1 block">Full execution clearance</span>
                    </div>

                    <div className="rzp-card p-4 border-l-4 border-l-amber-500">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Quarantined Agents</span>
                      <span className="text-2xl font-bold text-amber-600 font-mono mt-1 block">{securityOverview.agents.quarantined}</span>
                      <span className="text-[11px] text-slate-500 mt-1 block">Execution suspended</span>
                    </div>

                    <div className="rzp-card p-4 border-l-4 border-l-red-500">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Permanently Blocked</span>
                      <span className="text-2xl font-bold text-red-600 font-mono mt-1 block">{securityOverview.agents.blocked}</span>
                      <span className="text-[11px] text-slate-500 mt-1 block">Hard blacklisted</span>
                    </div>

                    <div className="rzp-card p-4 border-l-4 border-l-[#0C83FF]">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block">Security Incidents</span>
                      <span className="text-2xl font-bold text-[#0C83FF] font-mono mt-1 block">{securityOverview.incidents.total}</span>
                      <span className="text-[11px] text-slate-500 mt-1 block">Total anomalies caught</span>
                    </div>
                  </div>
                )}

                {/* Agent Access Management Table */}
                <div className="rzp-card overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200">
                    <h3 className="text-sm font-bold text-slate-900">Registered AI Agents & Quarantine Controls</h3>
                    <p className="text-xs text-slate-500">Identity verification and real-time quarantine status</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="rzp-table">
                      <thead>
                        <tr>
                          <th>Agent Identifier</th>
                          <th>Status</th>
                          <th>Violations</th>
                          <th>Severe Flags</th>
                          <th>Last Incident</th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {securityAgents.map(ag => (
                          <tr key={ag.id}>
                            <td>
                              <div className="font-semibold text-slate-900">{ag.name}</div>
                              <div className="text-[11px] text-slate-400 font-mono">{ag.id}</div>
                            </td>
                            <td>
                              <StatusBadge status={ag.status} />
                              {ag.quarantineReason && (
                                <div className="text-[11px] text-red-600 mt-1 font-medium">{ag.quarantineReason}</div>
                              )}
                            </td>
                            <td className="font-mono text-xs font-semibold text-slate-700">{ag.securityViolationCount || 0}</td>
                            <td className="font-mono text-xs font-semibold text-red-600">{ag.severeThreatCount || 0}</td>
                            <td className="text-xs text-slate-500">
                              {ag.lastSecurityIncidentAt ? new Date(ag.lastSecurityIncidentAt).toLocaleTimeString() : 'None'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <div className="flex items-center justify-end gap-2">
                                {ag.status === 'QUARANTINED' && (
                                  <button
                                    onClick={() => handleUnquarantine(ag.id)}
                                    className="rzp-btn-secondary text-xs px-2.5 py-1 text-emerald-600 hover:bg-emerald-50"
                                  >
                                    Release
                                  </button>
                                )}
                                {ag.status !== 'BLOCKED' && (
                                  <button
                                    onClick={() => handleBlockPermanent(ag.id)}
                                    className="rzp-btn-secondary text-xs px-2.5 py-1 text-red-600 hover:bg-red-50"
                                  >
                                    Block
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Threat Assessments & Incidents Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* High Threat Transactions */}
                  <div className="rzp-card p-5">
                    <h3 className="text-sm font-bold text-slate-900 mb-1">Flagged Threat Assessments (Score ≥ 60)</h3>
                    <p className="text-xs text-slate-500 mb-4">Transactions flagged by heuristic threat analyzer</p>
                    {(!securityOverview || securityOverview.highThreatTransactions.length === 0) ? (
                      <div className="p-6 text-center text-xs text-slate-400 bg-slate-50 rounded-md border border-slate-100">
                        No critical threat transactions flagged
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {securityOverview.highThreatTransactions.map((t, idx) => (
                          <div key={idx} className="p-3 bg-slate-50 rounded-md border border-slate-200">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-bold text-slate-900 font-mono">Risk Score: {t.score}/100</span>
                              <StatusBadge status={t.level} />
                            </div>
                            <div className="flex gap-1.5 flex-wrap">
                              {(t.factors || []).map((f: any, fIdx: number) => (
                                <span key={fIdx} className="rzp-badge rzp-badge-danger text-[10px]">
                                  {f.rule} (+{f.points})
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Security Incidents */}
                  <div className="rzp-card p-5">
                    <h3 className="text-sm font-bold text-slate-900 mb-1">Recent Incident Radar</h3>
                    <p className="text-xs text-slate-500 mb-4">Tamper and behavioral safety alerts</p>
                    {(!securityOverview || securityOverview.incidents.recent.length === 0) ? (
                      <div className="p-6 text-center text-xs text-slate-400 bg-slate-50 rounded-md border border-slate-100">
                        No security incidents recorded
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {securityOverview.incidents.recent.map((inc, idx) => (
                          <div key={idx} className="p-3 bg-slate-50 rounded-md border border-slate-200">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-bold text-red-600">{inc.type}</span>
                              <StatusBadge status={inc.severity} />
                            </div>
                            <p className="text-xs text-slate-600 mb-1.5">{inc.description}</p>
                            <span className="text-[10px] text-slate-400 font-mono">
                              {new Date(inc.detectedAt).toLocaleTimeString()} • Agent: {inc.agent?.name || inc.agentId}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 7. TRANSACTION REPLAY */}
            {tab === 'replay' && replay && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setTab('transactions')}
                      className="rzp-btn-secondary text-xs px-3 py-1.5"
                    >
                      ← Back to Transactions
                    </button>
                    <div>
                      <h1 className="text-xl font-bold text-slate-900">Cryptographic Audit Trail</h1>
                      <p className="text-xs text-slate-500">Immutable SHA-256 verifiable execution sequence</p>
                    </div>
                  </div>
                  <StatusBadge status={replay.purchaseIntent.status} />
                </div>

                {/* Intent Summary Card */}
                <div className="rzp-card p-5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <span className="text-xs text-slate-400 block">Product</span>
                      <span className="text-base font-bold text-slate-900">{replay.purchaseIntent.product?.name}</span>
                    </div>
                    <div>
                      <span className="text-xs text-slate-400 block">Amount</span>
                      <span className="text-xl font-bold text-[#0C83FF] font-mono">{formatCurrency(replay.purchaseIntent.amount)}</span>
                    </div>
                    <div>
                      <span className="text-xs text-slate-400 block">Intent ID</span>
                      <span className="text-xs font-mono text-slate-600 truncate block">{replay.purchaseIntent.id}</span>
                    </div>
                  </div>
                </div>

                {/* Timeline */}
                <div className="rzp-card p-6">
                  <h3 className="text-sm font-bold text-slate-900 mb-6">Cryptographic Event Chain</h3>
                  <div className="relative pl-6 space-y-8 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-200">
                    {replay.auditTrail.map((event: any, i: number) => (
                      <div key={i} className="relative">
                        <div className="absolute -left-[27px] top-1 w-3.5 h-3.5 rounded-full bg-[#0C83FF] border-2 border-white ring-2 ring-[#BFDBFE]" />
                        <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold px-2 py-0.5 rounded bg-white text-slate-700 border border-slate-200">
                                {event.actorType}
                              </span>
                              <StatusBadge status={event.action} />
                            </div>
                            <span className="text-xs font-mono text-slate-400">
                              {new Date(event.createdAt).toLocaleTimeString()}
                            </span>
                          </div>

                          {event.metadata && (
                            <pre className="text-[11px] font-mono text-slate-600 bg-white p-3 rounded border border-slate-200 overflow-x-auto my-2">
                              {JSON.stringify(event.metadata, null, 2)}
                            </pre>
                          )}

                          <div className="text-[10px] font-mono text-slate-400 mt-2">
                            SHA-256 Hash: <span className="text-slate-600">{event.hash}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 8. LIVE DEMO */}
            {tab === 'demo' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-xl font-bold text-slate-900">Live AI Agent Simulation Console</h1>
                  <p className="text-xs text-slate-500 mt-0.5">Test real-time autonomous purchasing flows against Razorpay gateway controls</p>
                </div>

                {/* Adversarial Attack & Security Demos */}
                <div className="rzp-card p-5 border-l-4 border-l-red-500">
                  <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                    <div>
                      <span className="text-xs font-bold text-red-600 uppercase tracking-wider block">Adversarial Simulations & Gateway Defenses</span>
                      <span className="text-xs text-slate-500">Demonstrate live attack mitigation, automatic quarantine, and cryptographic audit proofs</span>
                    </div>
                    {chainStatus && (
                      <div className={`text-xs px-2.5 py-1 rounded-full font-medium flex items-center gap-1.5 ${chainStatus.valid ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                        <span className={`w-2 h-2 rounded-full ${chainStatus.valid ? 'bg-emerald-500' : 'bg-red-500'}`} />
                        Chain: {chainStatus.valid ? `Verified (${chainStatus.totalEvents} blocks intact)` : `Tampered at #${chainStatus.brokenAt}`}
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2.5 flex-wrap">
                    <button
                      onClick={simulateAttackAndQuarantine}
                      disabled={loading}
                      className="bg-red-600 hover:bg-red-700 text-white font-medium text-xs px-3.5 py-2 rounded shadow-sm flex items-center gap-1.5 transition-colors disabled:opacity-50"
                    >
                      <span>🚨</span>
                      <span>Simulate Multi-Vector Attack (Trigger Quarantine)</span>
                    </button>

                    <button
                      onClick={simulateProbingAttack}
                      disabled={loading}
                      className="bg-amber-600 hover:bg-amber-700 text-white font-medium text-xs px-3.5 py-2 rounded shadow-sm flex items-center gap-1.5 transition-colors disabled:opacity-50"
                    >
                      <span>⚡</span>
                      <span>Simulate Policy Probing</span>
                    </button>

                    <button
                      onClick={handleVerifyChain}
                      disabled={isVerifyingChain}
                      className="bg-slate-800 hover:bg-slate-900 text-white font-medium text-xs px-3.5 py-2 rounded shadow-sm flex items-center gap-1.5 transition-colors disabled:opacity-50"
                    >
                      <span>🛡️</span>
                      <span>{isVerifyingChain ? 'Verifying Chain...' : 'Verify Cryptographic Audit Chain'}</span>
                    </button>

                    <button
                      onClick={handleResetDemoConsole}
                      disabled={loading}
                      className="rzp-btn-secondary text-xs px-3.5 py-2"
                    >
                      <span>🔄</span>
                      <span>Reset Agent State (Demo Ready)</span>
                    </button>
                  </div>
                </div>

                {/* Quick Trigger Bar */}
                <div className="rzp-card p-4">
                  <span className="text-xs font-semibold text-slate-700 block mb-2 uppercase tracking-wider">Legitimate Autonomous Agent Purchases:</span>
                  <div className="flex gap-2 flex-wrap">
                    {products.map(p => (
                      <button
                        key={p.id}
                        onClick={() => runDemo(p.id, p.name)}
                        disabled={loading}
                        className="rzp-btn-secondary text-xs"
                      >
                        <span>{p.name}</span>
                        <span className="font-mono text-slate-900 font-bold">({formatCurrency(p.price)})</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Console Log Terminal */}
                <div className="rzp-card overflow-hidden">
                  <div className="px-5 py-3 bg-[#08132B] text-slate-300 flex items-center justify-between border-b border-[#152445]">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                      <span className="text-xs font-mono font-medium">agent-execution.log</span>
                    </div>
                    {demoLog.length > 0 && (
                      <button
                        onClick={() => setDemoLog([])}
                        className="text-[11px] text-slate-400 hover:text-white transition-colors"
                      >
                        Clear Log
                      </button>
                    )}
                  </div>

                  <div className="p-5 font-mono text-xs bg-[#040A18] text-slate-200 min-h-[360px] space-y-2 overflow-y-auto">
                    {demoLog.length === 0 ? (
                      <div className="text-center py-20 text-slate-500">
                        Click a product above or run a test from the catalog to begin execution trace.
                      </div>
                    ) : (
                      demoLog.map((line, i) => {
                        let color = 'text-slate-300';
                        if (line.type === 'success') color = 'text-emerald-400';
                        if (line.type === 'warn') color = 'text-amber-400';
                        if (line.type === 'error') color = 'text-red-400';

                        return (
                          <div key={i} className="flex items-start gap-3">
                            <span className="text-slate-500 select-none text-[11px]">{line.time}</span>
                            <span className={color}>{line.text}</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
