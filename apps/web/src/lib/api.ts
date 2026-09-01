const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Admin API key — matches ADMIN_API_KEY env var on server
// In a real deployment this would come from a secure session/token
const ADMIN_KEY = process.env.NEXT_PUBLIC_ADMIN_KEY || 'dev-admin-key-change-in-production';

export async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API error: ${res.status}`);
  }
  
  return res.json();
}

// Admin fetch — includes X-Admin-Key header for protected endpoints
export async function fetchAdminAPI<T>(path: string, options?: RequestInit): Promise<T> {
  return fetchAPI<T>(path, {
    ...options,
    headers: {
      'x-admin-key': ADMIN_KEY,
      ...options?.headers,
    },
  });
}

export const api = {
  // Products
  getProducts: () => fetchAPI<any>('/api/products'),
  searchProducts: (query: string, maxPrice?: number) => 
    fetchAPI<any>(`/api/products/search?query=${encodeURIComponent(query)}${maxPrice ? `&maxPrice=${maxPrice}` : ''}`),
  
  // Dashboard
  getStats: () => fetchAPI<any>('/api/dashboard/stats'),
  
  // Purchase Intents
  createPurchaseIntent: (data: any) => 
    fetchAPI<any>('/api/purchase-intents', { method: 'POST', body: JSON.stringify(data) }),
  evaluatePurchase: (id: string) => 
    fetchAPI<any>(`/api/purchase-intents/${id}/evaluate`, { method: 'POST', body: '{}' }),
  executePurchase: (id: string) =>
    fetchAPI<any>(`/api/purchase-intents/${id}/execute`, { method: 'POST', body: '{}' }),
  completePurchase: (id: string) =>
    fetchAPI<any>(`/api/purchase-intents/${id}/complete`, { method: 'POST', body: '{}' }),
  approvePurchase: (id: string) =>
    fetchAdminAPI<any>(`/api/purchase-intents/${id}/approve`, { method: 'POST', body: JSON.stringify({ approvedBy: 'merchant_admin' }) }),
  denyPurchase: (id: string) =>
    fetchAdminAPI<any>(`/api/purchase-intents/${id}/deny`, { method: 'POST', body: JSON.stringify({ deniedBy: 'merchant_admin' }) }),
  
  // Transactions
  getTransactions: () => fetchAPI<any>('/api/transactions'),
  getTransactionReplay: (id: string) => fetchAPI<any>(`/api/transactions/${id}/replay`),
  
  // Audit
  getAuditEvents: () => fetchAPI<any>('/api/audit-events'),
  verifyAuditChain: () => fetchAPI<any>('/api/audit/verify'),
  
  // Policies (admin)
  getPolicies: () => fetchAPI<any>('/api/policies'),
  updatePolicy: (id: string, data: any) =>
    fetchAdminAPI<any>(`/api/policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  
  // Approvals
  getPendingApprovals: () => fetchAPI<any>('/api/approvals/pending'),
  
  // Agents
  getAgents: () => fetchAPI<any>('/api/agents'),

  // Security & Zero-Trust
  getSecurityOverview: () => fetchAPI<any>('/api/security/overview'),
  getSecurityAgents: () => fetchAPI<any>('/api/security/agents'),
  getSecurityIncidents: () => fetchAPI<any>('/api/security/incidents'),
  unquarantineAgent: (id: string) => 
    fetchAdminAPI<any>(`/api/security/agents/${id}/unquarantine`, { method: 'POST', body: '{}' }),
  blockAgentPermanent: (id: string, reason?: string) => 
    fetchAdminAPI<any>(`/api/security/agents/${id}/block-permanent`, { method: 'POST', body: JSON.stringify({ reason }) }),

  // Demo — Hackathon live demonstration endpoints
  simulateAttack: (agentId?: string) =>
    fetchAPI<any>('/api/demo/simulate-attack', { method: 'POST', body: JSON.stringify({ agentId: agentId || 'agent_shopping_01' }) }),
  resetDemo: (agentId?: string) =>
    fetchAPI<any>('/api/demo/reset', { method: 'POST', body: JSON.stringify({ agentId: agentId || 'agent_shopping_01' }) }),
};
