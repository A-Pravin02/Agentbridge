// ============================================
// AgentBridge API Server
// The Authorization Layer for AI Commerce
// ============================================

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { productRoutes } from './routes/products.js';
import { purchaseRoutes } from './routes/purchases.js';
import { dashboardRoutes } from './routes/dashboard.js';

// ---- Admin API Key Middleware ----
// Protects merchant admin endpoints (quarantine, block, policy update)
// Set ADMIN_API_KEY env variable; falls back to a dev default for local demo
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'dev-admin-key-change-in-production';

const ADMIN_ENDPOINTS = [
  '/api/security/agents',
  '/api/policies',
];

async function adminAuthHook(request: FastifyRequest, reply: FastifyReply) {
  const url = request.url;
  const method = request.method;

  // Only enforce on mutating admin routes
  const isAdminMutate = method !== 'GET' && ADMIN_ENDPOINTS.some(p => url.startsWith(p));
  if (!isAdminMutate) return;

  const key = request.headers['x-admin-key'];
  if (key !== ADMIN_API_KEY) {
    return reply.status(401).send({
      success: false,
      error: 'Unauthorized — missing or invalid admin key',
    });
  }
}

async function main() {
  const app = Fastify({ logger: true });

  // Register CORS — restrict to known frontend origin (GAP-02 fix)
  const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
  ];
  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'), false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  });

  // Register admin auth hook (GAP-01 fix)
  app.addHook('onRequest', adminAuthHook);

  // Register routes
  app.register(productRoutes, { prefix: '/api' });
  app.register(purchaseRoutes, { prefix: '/api' });
  app.register(dashboardRoutes, { prefix: '/api' });

  // Root route
  app.get('/', async () => ({
    service: 'AgentBridge API Server',
    status: 'online',
    dashboardUI: 'http://localhost:3000',
    documentation: {
      health: '/api/health',
      products: '/api/products',
      dashboardStats: '/api/dashboard/stats',
      transactions: '/api/transactions',
      securityOverview: '/api/security/overview',
      securityAgents: '/api/security/agents',
    },
  }));

  // Health check
  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'agentbridge-api',
    timestamp: new Date().toISOString(),
  }));

  // Start server
  const PORT = parseInt(process.env.API_PORT || '3001', 10);
  const HOST = process.env.API_HOST || '0.0.0.0';

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`\n🚀 AgentBridge API running at http://localhost:${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📦 Products: http://localhost:${PORT}/api/products`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/api/dashboard/stats\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
