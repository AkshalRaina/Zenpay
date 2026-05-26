import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { config } from '../config';
import { RateLimitError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Redis key prefix for rate limiting.
 */
const RATE_LIMIT_PREFIX = 'ratelimit:';

/**
 * Redis-based sliding window rate limiter middleware.
 *
 * Tracks request counts per IP address over a configurable time window.
 * Sets standard rate limit headers on every response.
 *
 * Uses a sorted set in Redis with timestamps as scores for the sliding window.
 */
export async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `${RATE_LIMIT_PREFIX}${ip}`;
  const windowMs = config.RATE_LIMIT_WINDOW_MS;
  const maxRequests = config.RATE_LIMIT_MAX_REQUESTS;
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    // Use a Redis pipeline for atomicity
    const pipeline = redis.pipeline();

    // Remove expired entries outside the window
    pipeline.zremrangebyscore(key, 0, windowStart);

    // Count current requests in the window
    pipeline.zcard(key);

    // Add the current request
    pipeline.zadd(key, now, `${now}:${Math.random()}`);

    // Set expiry on the key
    pipeline.pexpire(key, windowMs);

    const results = await pipeline.exec();

    // zcard result is at index 1
    const currentCount = (results?.[1]?.[1] as number) || 0;

    // Set rate limit headers
    const remaining = Math.max(0, maxRequests - currentCount - 1);
    const resetTime = Math.ceil((now + windowMs) / 1000);

    res.set({
      'X-RateLimit-Limit': maxRequests.toString(),
      'X-RateLimit-Remaining': remaining.toString(),
      'X-RateLimit-Reset': resetTime.toString(),
    });

    if (currentCount >= maxRequests) {
      const retryAfterSeconds = Math.ceil(windowMs / 1000);
      res.set('Retry-After', retryAfterSeconds.toString());

      logger.warn('Rate limit exceeded', { ip, currentCount, maxRequests });
      throw new RateLimitError(retryAfterSeconds);
    }

    next();
  } catch (error) {
    if (error instanceof RateLimitError) {
      next(error);
      return;
    }

    // If Redis is down, allow the request (fail-open)
    logger.error('Rate limiter error — failing open', { error });
    next();
  }
}
