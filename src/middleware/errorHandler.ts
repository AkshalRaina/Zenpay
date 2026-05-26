import { Request, Response, NextFunction } from 'express';
import { AppError, RateLimitError } from '../utils/errors';
import { logger } from '../utils/logger';
import { StatusCodes } from 'http-status-codes';

/**
 * Global error handler middleware.
 *
 * Catches all errors thrown in route handlers and middleware:
 * - AppError subclasses → maps to appropriate HTTP status + structured response
 * - Unknown errors → 500 Internal Server Error
 *
 * Logs all errors with context. Non-operational errors are logged at 'error' level
 * with full stack traces.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const correlationId = req.headers['x-request-id'] as string;

  if (err instanceof AppError) {
    // Operational error — expected, handled gracefully
    const logLevel = err.statusCode >= 500 ? 'error' : 'warn';

    logger[logLevel]('Operational error', {
      correlationId,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      details: err.details,
      path: req.originalUrl,
      method: req.method,
    });

    // Special handling for rate limit errors
    if (err instanceof RateLimitError) {
      res.set('Retry-After', err.retryAfter.toString());
    }

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    });
    return;
  }

  // Unexpected error — log with full stack trace
  logger.error('Unexpected error', {
    correlationId,
    message: err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
  });

  res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message:
        process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
    },
  });
}

/**
 * 404 Not Found handler for unmatched routes.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(StatusCodes.NOT_FOUND).json({
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`,
    },
  });
}
