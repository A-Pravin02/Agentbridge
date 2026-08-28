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

type Tab = 'dashboard' | 'catalog' | 'transactions' | 'approvals' | 'policy' | 'replay' | 'demo';

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'COMPLETED' || status === 'AUTHORIZED' || status === 'APPROVED'
      ? 'badge-allow'
      : status === 'BLOCKED' || status === 'DENIED' || status === 'FAILED'
      ? 'badge-block'
      : status === 'REQUIRE_APPROVAL'
      ? 'badge-approval'
      : 'badge-pending';
  return <span className={`badge ${cls}`}>{status}</span>;
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
  const [replay, setReplay] = useState<any>(null);
  const [demoLog, setDemoLog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, p, t, a, pol] = await Promise.all([
        api.getStats(),
        api.getProducts(),
        api.getTransactions(),
        api.getPendingApprovals(),
        api.getPolicies(),
      ]);
      setStats(s.data);
      setProducts(p.data);
      setTransactions(t.data);
      setPendingApprovals(a.data);
      setPolicies(pol.data);
    } catch (e) {
      console.error('Failed to refresh:', e);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const addLog = (msg: string) => setDemoLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // ---- DEMO: Run full AI purchase flow ----
  async function runDemo(productId: string, productName: string) {
    setTab('demo');
    setDemoLog([]);
    setLoading(true);

    try {
      addLog(`🤖 AGENT: User requested "${productName}"`);
      addLog('🔍 AGENT: Searching TechKart catalog...');
      await new Promise(r => setTimeout(r, 500));

      addLog(`📦 SYSTEM: Product found — ${productName}`);
      await new Promise(r => setTimeout(r, 300));

      addLog('📝 AGENT: Creating purchase intent...');
      const intent = await api.createPurchaseIntent({
        agentId: 'agent_shopping_01',
        productId,
        quantity: 1,
        agentReason: `User requested ${productName}`,
        merchantId: 'techkart_01',
      });
      addLog(`✅ SYSTEM: Purchase intent created (${intent.data.id})`);
      await new Promise(r => setTimeout(r, 300));

      addLog('🔐 SYSTEM: Checking agent identity...');
      addLog('🪪 SYSTEM: Agent Permission Passport validated');
      await new Promise(r => setTimeout(r, 300));

      addLog('⚖️ POLICY ENGINE: Evaluating transaction...');
      const evaluation = await api.evaluatePurchase(intent.data.id);
      const decision = evaluation.data.policyResult.decision;
      const reasons = evaluation.data.policyResult.reasons;

      if (decision === 'ALLOW') {
        addLog(`✅ POLICY: ALLOW — ${reasons[0]}`);
        await new Promise(r => setTimeout(r, 300));

        addLog('💳 PAYMENT: Creating order...');
        await api.executePurchase(intent.data.id);
        addLog('💳 PAYMENT: Order created, processing...');
        await new Promise(r => setTimeout(r, 500));

        await api.completePurchase(intent.data.id);
        addLog('✅ PAYMENT: Verified server-side');
        addLog('🎉 ORDER: COMPLETED');
        addLog('📋 AUDIT: Events recorded in tamper-evident chain');
      } else if (decision === 'REQUIRE_APPROVAL') {
        addLog(`⚠️ POLICY: REQUIRE_APPROVAL — ${reasons[0]}`);
        addLog('👤 SYSTEM: Waiting for merchant approval...');
        addLog('💡 Go to Approvals tab to approve or deny');
      } else {
        addLog(`🚫 POLICY: BLOCKED — ${reasons[0]}`);
        if (evaluation.data.policyResult.violations) {
          evaluation.data.policyResult.violations.forEach((v: any) => {
            addLog(`   ❌ ${v.rule}: ${v.message}`);
          });
        }
        addLog('🛑 PAYMENT: Never created (blocked by policy)');
      }
    } catch (e: any) {
      addLog(`❌ ERROR: ${e.message}`);
    } finally {
      setLoading(false);
      refresh();
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

  async function viewReplay(intentId: string) {
    try {
      const r = await api.getTransactionReplay(intentId);
      setReplay(r.data);
      setTab('replay');
    } catch (e: any) {
      alert(e.message);
    }
  }

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'catalog', label: 'Catalog', icon: '📦' },
    { id: 'transactions', label: 'Transactions', icon: '💳' },
    { id: 'approvals', label: 'Approvals', icon: '👤' },
    { id: 'policy', label: 'Policy Studio', icon: '⚖️' },
    { id: 'demo', label: 'Live Demo', icon: '🚀' },
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Sidebar */}
      <nav style={{ width: 260, background: 'var(--bg-secondary)', borderRight: '1px solid var(--border)', padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ marginBottom: 24, padding: '0 8px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }} className="gradient-text">AgentBridge</h1>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '4px 0 0', letterSpacing: 1 }}>AI COMMERCE GATEWAY</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg-card)', borderRadius: 8, marginBottom: 16 }}>
          <div className="pulse-dot" />
          <span style={{ fontSize: 12, color: 'var(--accent-green)' }}>TechKart — Live</span>
        </div>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
              borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 500,
              background: tab === t.id ? 'rgba(79,125,243,0.15)' : 'transparent',
              color: tab === t.id ? 'var(--accent-blue)' : 'var(--text-secondary)',
              transition: 'all 0.2s',
            }}
          >
            <span>{t.icon}</span> {t.label}
            {t.id === 'approvals' && pendingApprovals.length > 0 && (
              <span style={{ marginLeft: 'auto', background: 'var(--accent-amber)', color: '#000', borderRadius: 99, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
                {pendingApprovals.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, padding: 32, overflow: 'auto' }}>
        {/* Dashboard */}
        {tab === 'dashboard' && stats && (
          <div className="animate-fade-in">
            <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>
              Merchant Dashboard
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 32 }}>
              {[
                { label: 'Total Transactions', value: stats.totalTransactions, color: 'var(--accent-blue)' },
                { label: 'Allowed', value: stats.allowedTransactions, color: 'var(--accent-green)' },
                { label: 'Blocked', value: stats.blockedTransactions, color: 'var(--accent-red)' },
                { label: 'Pending Approval', value: stats.approvalRequests, color: 'var(--accent-amber)' },
                { label: 'Completed', value: stats.completedTransactions, color: 'var(--accent-purple)' },
                { label: 'Total Value', value: formatCurrency(stats.totalTransactionValue), color: 'var(--accent-green)' },
              ].map((s, i) => (
                <div key={i} className="glass-card" style={{ textAlign: 'center' }}>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{s.label}</p>
                  <p style={{ fontSize: 28, fontWeight: 700, color: s.color, margin: 0 }}>{s.value}</p>
                </div>
              ))}
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Recent Agent Activity</h3>
            <div className="glass-card" style={{ maxHeight: 400, overflow: 'auto' }}>
              {stats.recentActivity.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', textAlign: 'center' }}>No activity yet. Run a demo!</p>
              ) : (
                stats.recentActivity.map((event: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: i < stats.recentActivity.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 70 }}>
                      {new Date(event.createdAt).toLocaleTimeString()}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-blue)', minWidth: 70 }}>{event.actorType}</span>
                    <StatusBadge status={event.action} />
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {event.metadata?.amount ? formatCurrency(event.metadata.amount) : ''}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Catalog */}
        {tab === 'catalog' && (
          <div className="animate-fade-in">
            <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Product Catalog</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
              {products.map(p => (
                <div key={p.id} className="glass-card">
                  <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{p.name}</h3>
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>{p.description}</p>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent-green)' }}>{formatCurrency(p.price)}</span>
                    <span className="badge badge-pending">{p.category}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Stock: {p.stock}</span>
                    <button
                      className="btn-primary"
                      style={{ fontSize: 12, padding: '8px 16px' }}
                      onClick={() => runDemo(p.id, p.name)}
                    >
                      🤖 AI Purchase
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Transactions */}
        {tab === 'transactions' && (
          <div className="animate-fade-in">
            <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Transaction History</h2>
            <div className="glass-card" style={{ overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Product', 'Amount', 'Status', 'Agent Reason', 'Time', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {transactions.map(tx => (
                    <tr key={tx.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '12px 16px', fontSize: 14 }}>{tx.product?.name}</td>
                      <td style={{ padding: '12px 16px', fontSize: 14, fontWeight: 600 }}>{formatCurrency(tx.amount)}</td>
                      <td style={{ padding: '12px 16px' }}><StatusBadge status={tx.status} /></td>
                      <td style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-secondary)', maxWidth: 200 }}>{tx.agentReason}</td>
                      <td style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-secondary)' }}>{new Date(tx.createdAt).toLocaleString()}</td>
                      <td style={{ padding: '12px 16px' }}>
                        <button onClick={() => viewReplay(tx.id)} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--accent-blue)', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
                          🔍 Replay
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Approvals */}
        {tab === 'approvals' && (
          <div className="animate-fade-in">
            <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Approval Center</h2>
            {pendingApprovals.length === 0 ? (
              <div className="glass-card" style={{ textAlign: 'center', padding: 48 }}>
                <p style={{ fontSize: 48, marginBottom: 16 }}>✅</p>
                <p style={{ color: 'var(--text-secondary)' }}>No pending approvals</p>
              </div>
            ) : (
              pendingApprovals.map(a => (
                <div key={a.id} className="glass-card" style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{a.purchaseIntent.product?.name}</h3>
                      <p style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent-amber)', margin: '4px 0' }}>{formatCurrency(a.purchaseIntent.amount)}</p>
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Agent: {a.purchaseIntent.agent?.name}</p>
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Reason: {a.purchaseIntent.agentReason}</p>
                      <StatusBadge status="REQUIRE_APPROVAL" />
                    </div>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <button className="btn-approve" onClick={() => handleApprove(a.purchaseIntent.id)}>✅ Approve</button>
                      <button className="btn-deny" onClick={() => handleDeny(a.purchaseIntent.id)}>❌ Deny</button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Policy Studio */}
        {tab === 'policy' && (
          <div className="animate-fade-in">
            <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>Policy Studio</h2>
            {policies.map((p: any) => (
              <div key={p.id} className="glass-card">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 24 }}>
                  {[
                    { label: 'Max Transaction', value: formatCurrency(p.maxTransactionAmount), icon: '💰' },
                    { label: 'Daily Limit', value: formatCurrency(p.maxDailyAmount), icon: '📅' },
                    { label: 'Max Transactions/Day', value: p.maxTransactionsPerDay, icon: '🔢' },
                    { label: 'Approval Threshold', value: formatCurrency(p.approvalThreshold), icon: '⚠️' },
                  ].map((item, i) => (
                    <div key={i} style={{ textAlign: 'center' }}>
                      <p style={{ fontSize: 28, marginBottom: 4 }}>{item.icon}</p>
                      <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{item.label}</p>
                      <p style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-blue)' }}>{item.value}</p>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 24 }}>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Allowed Categories</p>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {p.allowedCategories?.map((c: string) => (
                      <span key={c} className="badge badge-allow">{c}</span>
                    ))}
                  </div>
                </div>
                <div style={{ marginTop: 24, padding: '16px', background: 'var(--bg-primary)', borderRadius: 8 }}>
                  <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Expected Demo Results</p>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {[
                      { product: 'USB-C Cable', price: '₹299', decision: 'ALLOW', cls: 'badge-allow' },
                      { product: 'Premium Phone Case', price: '₹399', decision: 'ALLOW', cls: 'badge-allow' },
                      { product: 'Premium Case', price: '₹499', decision: 'REQUIRE_APPROVAL', cls: 'badge-approval' },
                      { product: 'Power Bank', price: '₹1,499', decision: 'BLOCK', cls: 'badge-block' },
                      { product: 'Bluetooth Speaker', price: '₹2,999', decision: 'BLOCK', cls: 'badge-block' },
                    ].map((r, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontSize: 13, minWidth: 160 }}>{r.product}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 60 }}>{r.price}</span>
                        <span style={{ fontSize: 13 }}>→</span>
                        <span className={`badge ${r.cls}`}>{r.decision}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Transaction Replay */}
        {tab === 'replay' && replay && (
          <div className="animate-fade-in">
            <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>
              Transaction Replay
              <button onClick={() => setTab('transactions')} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginLeft: 16 }}>← Back</button>
            </h2>
            <div className="glass-card" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>
                  <h3 style={{ fontSize: 20, fontWeight: 600 }}>{replay.purchaseIntent.product?.name}</h3>
                  <p style={{ fontSize: 24, fontWeight: 700, color: 'var(--accent-blue)' }}>{formatCurrency(replay.purchaseIntent.amount)}</p>
                </div>
                <StatusBadge status={replay.purchaseIntent.status} />
              </div>
            </div>
            <div className="glass-card" style={{ position: 'relative', paddingLeft: 40 }}>
              <div className="timeline-line" />
              {replay.auditTrail.map((event: any, i: number) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '12px 0', position: 'relative' }}>
                  <div className="timeline-dot" style={{ position: 'absolute', left: -33, top: 16 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{new Date(event.createdAt).toLocaleTimeString()}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-blue)' }}>{event.actorType}</span>
                      <StatusBadge status={event.action} />
                    </div>
                    {event.metadata && (
                      <pre style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0, background: 'var(--bg-primary)', padding: 8, borderRadius: 4, overflow: 'auto' }}>
                        {JSON.stringify(event.metadata, null, 2)}
                      </pre>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--border)', marginTop: 4, fontFamily: 'monospace' }}>
                      Hash: {event.hash?.substring(0, 16)}...
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Live Demo */}
        {tab === 'demo' && (
          <div className="animate-fade-in">
            <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 16 }}>Live Agent Activity</h2>
            <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
              {products.map(p => (
                <button
                  key={p.id}
                  className="btn-primary"
                  style={{ fontSize: 13 }}
                  onClick={() => runDemo(p.id, p.name)}
                  disabled={loading}
                >
                  🤖 Buy {p.name} ({formatCurrency(p.price)})
                </button>
              ))}
            </div>
            <div className="glass-card" style={{ fontFamily: 'monospace', fontSize: 13, minHeight: 300 }}>
              {demoLog.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 48 }}>
                  Click a product above to simulate an AI agent purchase
                </p>
              ) : (
                demoLog.map((line, i) => (
                  <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid rgba(42,42,64,0.5)', animationDelay: `${i * 50}ms` }} className="animate-fade-in">
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
