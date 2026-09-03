// ============================================
// AgentBridge API - Entry Point
// ============================================

import { buildServer } from './server.js';
import { getConfig } from './config.js';
import { prisma } from './db.js';
import { purgeExpired } from './services/idempotency-service.js';
import { expireStaleApprovals } from './services/approval-service.js';

async function main() {
  const config = getConfig();
  const app = await buildServer(config);

  // Housekeeping: expire stale approvals and purge dead nonces/keys.
  const janitor = setInterval(() => {
    void expireStaleApprovals().catch((e) => app.log.error({ err: e }, 'approval expiry failed'));
    void purgeExpired().catch((e) => app.log.error({ err: e }, 'purge failed'));
  }, 60_000);
  janitor.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(janitor);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  app.log.info(
    { port: config.API_PORT, paymentMode: config.PAYMENT_MODE, demoRoutes: config.ENABLE_DEMO_ROUTES },
    'AgentBridge API ready'
  );
}

main().catch((error) => {
  console.error('Failed to start AgentBridge:', error);
  process.exit(1);
});
