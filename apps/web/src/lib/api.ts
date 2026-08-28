const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

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
    fetchAPI<any>(`/api/purchase-intents/${id}/approve`, { method: 'POST', body: JSON.stringify({ approvedBy: 'merchant_admin' }) }),
  denyPurchase: (id: string) =>
    fetchAPI<any>(`/api/purchase-intents/${id}/deny`, { method: 'POST', body: JSON.stringify({ deniedBy: 'merchant_admin' }) }),
  
  // Transactions
  getTransactions: () => fetchAPI<any>('/api/transactions'),
  getTransactionReplay: (id: string) => fetchAPI<any>(`/api/transactions/${id}/replay`),
  
  // Audit
  getAuditEvents: () => fetchAPI<any>('/api/audit-events'),
  verifyAuditChain: () => fetchAPI<any>('/api/audit/verify'),
  
  // Policies
  getPolicies: () => fetchAPI<any>('/api/policies'),
  updatePolicy: (id: string, data: any) =>
    fetchAPI<any>(`/api/policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  
  // Approvals
  getPendingApprovals: () => fetchAPI<any>('/api/approvals/pending'),
  
  // Agents
  getAgents: () => fetchAPI<any>('/api/agents'),
};
