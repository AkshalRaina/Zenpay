import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { prisma } from '../config/database';
import { config } from '../config';
import { hashBody, generateId } from '../utils/helpers';
import { logger } from '../utils/logger';
import { IdempotencyConflictError } from '../utils/errors';
import { StatusCodes } from 'http-status-codes';

/**
 * Redis key prefix for idempotency.
 */
const IDEMPOTENCY_PREFIX = 'idempotency:';

/**
 * Idempotency middleware.
 *
 * Ensures that repeated POST requests with the same `Idempotency-Key` header
 * do not create duplicate resources.
 *
 * Flow:
 * 1. If no Idempotency-Key header → proceed normally (no idempotency)
 * 2. If key exists in Redis with status 'completed' → return cached response
 * 3. If key exists with status 'processing' → return 409 Conflict
 * 4. If key is new → mark as 'processing', proceed, then cache the response
 */
export async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  // No key provided — proceed without idempotency
  if (!idempotencyKey) {
    next();
    return;
  }

  const redisKey = `${IDEMPOTENCY_PREFIX}${idempotencyKey}`;
  const requestHash = hashBody(req.body);

  try {
    // Check Redis first (fast path)
    const existing = await redis.get(redisKey);

    if (existing) {
      const cached = JSON.parse(existing);

      // Verify the request body matches (prevent key reuse with different payloads)
      if (cached.requestBodyHash !== requestHash) {
        res.status(StatusCodes.UNPROCESSABLE_ENTITY).json({
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REUSE',
            message: 'Idempotency key was already used with a different request body',
          },
        });
        return;
      }

      if (cached.status === 'completed') {
        // Return cached response
        logger.debug('Idempotency: returning cached response', { idempotencyKey });
        res.status(cached.responseCode).json(cached.responseBody);
        return;
      }

      if (cached.status === 'processing') {
        // Request is still being processed
        throw new IdempotencyConflictError(idempotencyKey);
      }
    }

    // New key — mark as processing in Redis
    const processingRecord = JSON.stringify({
      status: 'processing',
      requestPath: req.path,
      requestBodyHash: requestHash,
      createdAt: new Date().toISOString(),
    });

    const ttlSeconds = config.IDEMPOTENCY_TTL_HOURS * 3600;
    await redis.set(redisKey, processingRecord, 'EX', ttlSeconds, 'NX');

    // Also persist in PostgreSQL for durability
    await prisma.idempotencyKey
      .create({
        data: {
          id: generateId(),
          key: idempotencyKey,
          requestPath: req.path,
          requestBodyHash: requestHash,
          status: 'PROCESSING',
          expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        },
      })
      .catch(() => {
        // Ignore duplicate key errors (race condition handled by Redis NX)
      });

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      // Cache the response in Redis
      const completedRecord = JSON.stringify({
        status: 'completed',
        requestPath: req.path,
        requestBodyHash: requestHash,
        responseCode: res.statusCode,
        responseBody: body,
        completedAt: new Date().toISOString(),
      });

      redis
        .set(redisKey, completedRecord, 'EX', ttlSeconds)
        .catch((err) => logger.error('Failed to cache idempotency response', { err }));

      // Also update PostgreSQL record
      prisma.idempotencyKey
        .updateMany({
          where: { key: idempotencyKey },
          data: {
            status: 'COMPLETED',
            responseCode: res.statusCode,
            responseBody: body as object,
          },
        })
        .catch((err) => logger.error('Failed to update idempotency DB record', { err }));

      return originalJson(body);
    }) as any;

    next();
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      next(error);
      return;
    }

    logger.error('Idempotency middleware error', { error, idempotencyKey });
    next(error);
  }
}
