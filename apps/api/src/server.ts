// ============================================
// AgentBridge - Server Assembly
// ============================================
// `buildServer` returns a configured, un-listened Fastify instance so tests can
// drive the real application through `inject()` with no network involved. The
// adversarial suite exercises exactly this object.

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { getConfig, type Config } from './config.js';
import { AppError, ValidationError } from './lib/errors.js';
import { InvalidTransitionError } from '@agentbridge/policy-engine';
import { registerRoutes } from './routes/index.js';

/**
 * Header and body keys that must never reach the logs.
 * Pino redaction is applied at the transport, so no call site can forget.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["x-agent-signature"]',
  'req.headers["x-razorpay-signature"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.token',
  'req.body.signature',
  'req.body.privateKey',
];

export async function buildServer(config: Config = getConfig()): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    },
    // Every request gets a correlation id, surfaced on errors.
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  // ---- Raw body capture ----
  // Webhook and agent signatures are computed over the exact bytes received.
  // Re-serializing parsed JSON changes key order and whitespace and would make
  // both checks meaningless, so the raw text is captured before parsing.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body: string, done) => {
      (req as unknown as { rawBody?: string }).rawBody = body;
      if (body === '' || body === undefined) return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch {
        done(new ValidationError([{ path: 'body', message: 'Body is not valid JSON' }]), undefined);
      }
    }
  );

  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header: a server-to-server or agent client, which is not
      // subject to the browser same-origin model. Signature auth governs those.
      if (!origin) return cb(null, true);
      if (config.ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error('Origin is not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Agent-Key-Id',
      'X-Request-Id',
      'X-Timestamp',
      'X-Agent-Signature',
      'X-Razorpay-Signature',
    ],
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    // Key on IP ONLY.
    //
    // Keying on X-Agent-Key-Id looks nicer — one noisy agent would not exhaust
    // the budget of everyone behind the same NAT — but it is an attacker-
    // controlled header, and this hook runs BEFORE authentication. An attacker
    // that varies the header gets a fresh bucket per request and the limiter
    // does nothing at all. (Verified: 15/15 requests passed a limit of 5.)
    //
    // Per-agent rate control is handled after authentication, by the velocity
    // rule in the policy engine, where the identity is proven rather than
    // asserted.
    keyGenerator: (req) => req.ip ?? 'anonymous',
    // The plugin THROWS this object into the error handler, so it must carry a
    // statusCode or the handler cannot tell it apart from an internal fault.
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      success: false,
      error: `Too many requests. Retry after ${Math.ceil(context.ttl / 1000)}s.`,
      code: 'RATE_LIMITED',
    }),
  });

  // ---- Central error handler ----
  // Every failure leaves through here, so no route can accidentally leak a
  // stack trace or an internal message.
  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);

    if (error instanceof ValidationError) {
      return reply.status(400).send({
        success: false,
        error: error.message,
        code: error.code,
        details: error.details,
        requestId,
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        success: false,
        error: 'Request validation failed',
        code: 'VALIDATION_FAILED',
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      });
    }

    if (error instanceof InvalidTransitionError) {
      request.log.warn({ from: error.from, to: error.to }, 'invalid state transition');
      return reply.status(409).send({
        success: false,
        error: 'The purchase is not in a state that allows this operation',
        code: 'INVALID_STATE',
        requestId,
      });
    }

    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, 'application error');
      return reply.status(error.statusCode).send({
        success: false,
        error: error.message,
        code: error.code,
        ...(error.meta ?? {}),
        requestId,
      });
    }

    // Rate limiting arrives as a thrown plain object, not an Error subclass.
    const thrown = error as unknown as { statusCode?: number; code?: string; error?: string };
    if (thrown?.statusCode === 429 || thrown?.code === 'RATE_LIMITED') {
      return reply.status(429).send({
        success: false,
        error: thrown.error ?? 'Too many requests',
        code: 'RATE_LIMITED',
        requestId,
      });
    }

    // Unexpected: log fully server-side, reveal nothing to the caller.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      requestId,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: 'Route not found',
      code: 'NOT_FOUND',
      requestId: String(request.id),
    });
  });

  await app.register(registerRoutes, { prefix: '/api' });

  app.get('/', async () => ({
    service: 'AgentBridge',
    tagline: 'The Authorization Layer for AI Commerce',
    docs: '/api/docs',
    health: '/api/health',
  }));

  return app;
}
