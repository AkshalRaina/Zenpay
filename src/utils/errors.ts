import { StatusCodes } from 'http-status-codes';

/**
 * Base application error class.
 * All custom errors extend this to enable consistent error handling.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number = StatusCodes.INTERNAL_SERVER_ERROR,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;

    // Capture proper stack trace (excludes constructor from trace)
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 400 Bad Request — invalid input or validation failure.
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, StatusCodes.BAD_REQUEST, 'VALIDATION_ERROR', true, details);
  }
}

/**
 * 401 Unauthorized — authentication or signature failure.
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', details?: Record<string, unknown>) {
    super(message, StatusCodes.UNAUTHORIZED, 'UNAUTHORIZED', true, details);
  }
}

/**
 * 404 Not Found — resource does not exist.
 */
export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    const message = identifier
      ? `${resource} with ID '${identifier}' not found`
      : `${resource} not found`;
    super(message, StatusCodes.NOT_FOUND, 'NOT_FOUND', true);
  }
}

/**
 * 409 Conflict — resource state conflict (e.g., duplicate, invalid transition).
 */
export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, StatusCodes.CONFLICT, 'CONFLICT', true, details);
  }
}

/**
 * 409 Conflict — specifically for idempotency key conflicts (request still processing).
 */
export class IdempotencyConflictError extends AppError {
  constructor(key: string) {
    super(
      `Request with idempotency key '${key}' is already being processed`,
      StatusCodes.CONFLICT,
      'IDEMPOTENCY_CONFLICT',
      true,
      { idempotencyKey: key },
    );
  }
}

/**
 * 502 Bad Gateway — external gateway returned an error.
 */
export class GatewayError extends AppError {
  public readonly gatewayCode: string;
  public readonly isRetryable: boolean;

  constructor(message: string, gatewayCode: string, isRetryable: boolean) {
    super(message, StatusCodes.BAD_GATEWAY, 'GATEWAY_ERROR', true, {
      gatewayCode,
      isRetryable,
    });
    this.gatewayCode = gatewayCode;
    this.isRetryable = isRetryable;
  }
}

/**
 * 503 Service Unavailable — circuit breaker is open.
 */
export class CircuitBreakerOpenError extends AppError {
  constructor(message: string = 'Service temporarily unavailable — circuit breaker is open') {
    super(message, StatusCodes.SERVICE_UNAVAILABLE, 'CIRCUIT_BREAKER_OPEN', true);
  }
}

/**
 * 423 Locked — could not acquire distributed lock.
 */
export class LockAcquisitionError extends AppError {
  constructor(resource: string) {
    super(
      `Could not acquire lock for resource '${resource}' — it is currently being processed`,
      423, // Locked
      'LOCK_ACQUISITION_FAILED',
      true,
    );
  }
}

/**
 * 429 Too Many Requests — rate limit exceeded.
 */
export class RateLimitError extends AppError {
  public readonly retryAfter: number;

  constructor(retryAfterSeconds: number) {
    super(
      `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds`,
      StatusCodes.TOO_MANY_REQUESTS,
      'RATE_LIMIT_EXCEEDED',
      true,
      { retryAfter: retryAfterSeconds },
    );
    this.retryAfter = retryAfterSeconds;
  }
}
