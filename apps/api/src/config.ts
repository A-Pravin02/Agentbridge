// ============================================
// AgentBridge - Configuration
// ============================================
// Every environment variable is validated at boot. The process refuses to
// start on invalid config rather than failing open at request time.
//
// There are NO insecure defaults for secrets. In production the process exits
// unless real values are supplied; in development a clearly-labelled ephemeral
// value is generated per boot, which cannot be silently shipped.

import { randomBytes } from 'crypto';
import { z } from 'zod';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * A secret that MUST be configured in production. In development a random
 * value is generated per boot — restarting invalidates old tokens, which is
 * exactly the behaviour that stops a dev default becoming a prod credential.
 */
function requiredSecret(name: string) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value && value.length >= 32) return value;
      if (value && value.length < 32) {
        ctx.addIssue({ code: 'custom', message: `${name} must be at least 32 characters` });
        return z.NEVER;
      }
      if (isProduction) {
        ctx.addIssue({ code: 'custom', message: `${name} must be set in production` });
        return z.NEVER;
      }
      return `dev-ephemeral-${randomBytes(24).toString('hex')}`;
    });
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Managed platforms (Railway, Render, Fly, Heroku) inject the port to bind as
   * `PORT` and expect the process to use it. Honour that first, then our own
   * `API_PORT`, then the local default — so the same build runs unchanged
   * locally and on a platform.
   */
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  /**
   * Bind loopback locally so a dev machine does not expose the API to its
   * network. A container must bind 0.0.0.0 or the platform's router cannot
   * reach it — hence the production default below.
   */
  API_HOST: z.string().optional(),

  DATABASE_URL: z.string().min(1).default('file:./dev.db'),

  /** Comma-separated browser origins permitted to call the API. */
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://127.0.0.1:3000')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  SESSION_SECRET: requiredSecret('SESSION_SECRET'),

  /** 'sandbox' uses the local provider; 'razorpay' calls the live test API. */
  PAYMENT_MODE: z.enum(['sandbox', 'razorpay']).default('sandbox'),
  RAZORPAY_KEY_ID: z.string().default('rzp_test_sandbox'),
  RAZORPAY_KEY_SECRET: requiredSecret('RAZORPAY_KEY_SECRET'),
  RAZORPAY_WEBHOOK_SECRET: requiredSecret('RAZORPAY_WEBHOOK_SECRET'),

  /** Maximum accepted clock skew on a signed agent request. */
  REQUEST_SKEW_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  REQUEST_ID_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  AUTHORIZATION_TTL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  APPROVAL_TTL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  SESSION_TTL_MS: z.coerce.number().int().positive().default(12 * 60 * 60 * 1000),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),

  /** Enables /api/demo/* endpoints. Must be off in production. */
  ENABLE_DEMO_ROUTES: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

type RawConfig = z.infer<typeof schema>;

/** Config as the application consumes it: port and host already resolved. */
export type Config = Omit<RawConfig, 'PORT'> & {
  API_PORT: number;
  API_HOST: string;
};

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  const raw = parsed.data;

  // PORT (platform-injected) wins over API_PORT (ours) wins over the default.
  const { PORT, ...rest } = raw;
  const config: Config = {
    ...rest,
    API_PORT: PORT ?? raw.API_PORT,
    // Containers must bind 0.0.0.0; local dev stays on loopback.
    API_HOST: raw.API_HOST ?? (raw.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  };

  if (config.NODE_ENV === 'production' && config.ENABLE_DEMO_ROUTES) {
    throw new Error('ENABLE_DEMO_ROUTES must be false in production');
  }
  if (config.NODE_ENV === 'production' && config.PAYMENT_MODE === 'sandbox') {
    throw new Error('PAYMENT_MODE must not be "sandbox" in production');
  }
  return config;
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: forces the next getConfig() to re-read the environment. */
export function resetConfigCache(): void {
  cached = null;
}
