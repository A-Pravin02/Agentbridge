// ============================================
// AgentBridge API Server
// The Authorization Layer for AI Commerce
// ============================================

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { productRoutes } from './routes/products.js';
import { purchaseRoutes } from './routes/purchases.js';
import { dashboardRoutes } from './routes/dashboard.js';

async function main() {
  const app = Fastify({ logger: true });

  // Register CORS
  app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  });

  // Register routes
  app.register(productRoutes, { prefix: '/api' });
  app.register(purchaseRoutes, { prefix: '/api' });
  app.register(dashboardRoutes, { prefix: '/api' });

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
