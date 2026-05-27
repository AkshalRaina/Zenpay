import Redis from 'ioredis';
import { config } from './index';

/**
 * Redis client singleton.
 * Used for idempotency keys, distributed locks, and rate limiting.
 */
const redisOptions: import('ioredis').RedisOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
  lazyConnect: true, // Don't connect until first command
};

const redis = config.REDIS_URL
  ? new Redis(config.REDIS_URL, redisOptions)
  : new Redis({
      ...redisOptions,
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD || undefined,
    });

redis.on('error', (err) => {
  // Logger not imported here to avoid circular dependencies.
  // Errors are logged at the application level during startup.
  console.error('[Redis] Connection error:', err.message); // eslint-disable-line no-console
});

redis.on('connect', () => {
  console.log('[Redis] Connected successfully'); // eslint-disable-line no-console
});

/**
 * Gracefully disconnect Redis.
 */
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}

/**
 * Verify Redis connectivity.
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

export { redis };
