import { z } from 'zod';

/**
 * Environment variable schema with validation and defaults.
 * All configuration is loaded once at startup and exported as a typed object.
 */
const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),

  // Redis
  REDIS_URL: z.string().url().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),

  // Queue
  QUEUE_CONCURRENCY: z.coerce.number().min(1).max(50).default(5),

  // Payment
  MAX_RETRIES: z.coerce.number().min(0).max(10).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().min(100).default(1000),
  RETRY_MAX_DELAY_MS: z.coerce.number().min(1000).default(30000),
  LOCK_TTL_MS: z.coerce.number().min(5000).default(30000),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().min(1).default(24),

  // Gateway
  GATEWAY_TIMEOUT_MS: z.coerce.number().min(1000).default(10000),
  WEBHOOK_SECRET: z.string().min(10, 'WEBHOOK_SECRET must be at least 10 characters'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().min(1000).default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().min(1).default(100),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables.
 * Throws a descriptive error at startup if any required variables are missing or invalid.
 */
function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`\n❌ Invalid environment configuration:\n${formatted}\n`);
  }

  return result.data;
}

export const config = loadConfig();
