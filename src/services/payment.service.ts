import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config';
import { paymentProducer } from '../queue/payment.producer';
import { gatewaySimulator } from '../gateway/gateway.simulator';
import { CircuitBreaker } from '../utils/circuitBreaker';
import { withLock, paymentLockKey } from '../utils/distributedLock';
import { logger, createChildLogger } from '../utils/logger';
import { generateId, isValidStateTransition, isRetryableError } from '../utils/helpers';
import { PaymentStatus, PaymentStatusType, TERMINAL_STATES, EventType } from '../utils/constants';
import { NotFoundError, ConflictError, GatewayError } from '../utils/errors';
import {
  CreatePaymentRequest,
  PaymentResponse,
  PaymentWithEvents,
  PaymentListFilters,
  PaginatedResponse,
  GatewayResult,
} from '../types';

// Circuit breaker for gateway calls
const gatewayCircuitBreaker = new CircuitBreaker('payment-gateway', {
  windowSize: 10,
  failureThreshold: 0.5,
  resetTimeout: 30000,
  halfOpenSuccessThreshold: 3,
});

/**
 * Core payment business logic service.
 *
 * Handles payment creation, processing, state transitions,
 * and coordinates with the gateway, queue, and distributed lock.
 */
export class PaymentService {
  /**
   * Create a new payment and enqueue it for processing.
   */
  async createPayment(
    data: CreatePaymentRequest,
    idempotencyKey?: string,
  ): Promise<PaymentResponse> {
    const paymentId = generateId();
    const log = createChildLogger({ paymentId });

    log.info('Creating payment', {
      amount: data.amount,
      currency: data.currency,
      merchantId: data.merchantId,
    });

    // Create payment + initial event in a transaction
    const payment = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.payment.create({
        data: {
          id: paymentId,
          amount: new Prisma.Decimal(data.amount),
          currency: data.currency.toUpperCase(),
          status: PaymentStatus.CREATED,
          merchantId: data.merchantId,
          customerEmail: data.customerEmail,
          description: data.description || null,
          idempotencyKey: idempotencyKey || null,
          maxRetries: config.MAX_RETRIES,
          metadata: (data.metadata as Prisma.InputJsonValue) || Prisma.JsonNull,
        },
      });

      // Audit event: CREATED
      await tx.paymentEvent.create({
        data: {
          id: generateId(),
          paymentId: created.id,
          fromStatus: null,
          toStatus: PaymentStatus.CREATED,
          eventType: EventType.STATE_CHANGE,
          eventData: {
            amount: data.amount,
            currency: data.currency,
            merchantId: data.merchantId,
          },
        },
      });

      // Transition to PENDING
      const pending = await this.transitionStateInTx(
        tx,
        created.id,
        PaymentStatus.CREATED,
        PaymentStatus.PENDING,
        created.version,
        { reason: 'Payment created and queued for processing' },
      );

      return pending;
    });

    // Enqueue for background processing
    await paymentProducer.enqueuePayment(paymentId);

    log.info('Payment created and queued', { status: payment.status });

    return this.toPaymentResponse(payment);
  }

  /**
   * Process a payment — acquire lock, call gateway, update state.
   * Called by the queue worker.
   */
  async processPayment(paymentId: string): Promise<void> {
    const log = createChildLogger({ paymentId });

    await withLock(paymentLockKey(paymentId), config.LOCK_TTL_MS, async () => {
      log.info('Processing payment — lock acquired');

      // Fetch current payment state
      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });

      if (!payment) {
        log.error('Payment not found during processing');
        throw new NotFoundError('Payment', paymentId);
      }

      // Only process payments in PENDING state
      if (payment.status !== PaymentStatus.PENDING) {
        log.warn('Payment not in PENDING state, skipping', { currentStatus: payment.status });
        return;
      }

      // Transition to PROCESSING
      const processing = await this.transitionState(
        paymentId,
        PaymentStatus.PENDING,
        PaymentStatus.PROCESSING,
        payment.version,
      );

      // Call gateway through circuit breaker
      let result: GatewayResult;
      try {
        const gatewayResponse = await gatewayCircuitBreaker.execute(() =>
          gatewaySimulator.processPayment({
            paymentId,
            amount: Number(payment.amount),
            currency: payment.currency,
            merchantId: payment.merchantId,
            customerEmail: payment.customerEmail,
            description: payment.description || undefined,
          }),
        );

        result = {
          success: gatewayResponse.success,
          gatewayReference: gatewayResponse.gatewayReference,
          errorCode: gatewayResponse.errorCode,
          errorMessage: gatewayResponse.errorMessage,
          pendingWebhook: gatewayResponse.status === 'pending',
        };
      } catch (error) {
        // Handle gateway errors
        if (error instanceof GatewayError) {
          result = {
            success: false,
            errorCode: error.gatewayCode as GatewayResult['errorCode'],
            errorMessage: error.message,
          };
        } else {
          // Unexpected error — treat as retryable
          result = {
            success: false,
            errorCode: 'INTERNAL_ERROR' as GatewayResult['errorCode'],
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }

      // Handle the result
      await this.handlePaymentResult(paymentId, result, processing.version);
    });
  }

  /**
   * Handle the gateway result — transition to appropriate state.
   */
  async handlePaymentResult(
    paymentId: string,
    result: GatewayResult,
    currentVersion: number,
  ): Promise<void> {
    const log = createChildLogger({ paymentId });

    // Record gateway response event
    await prisma.paymentEvent.create({
      data: {
        id: generateId(),
        paymentId,
        fromStatus: PaymentStatus.PROCESSING,
        toStatus: PaymentStatus.PROCESSING,
        eventType: EventType.GATEWAY_RESPONSE,
        eventData: result as unknown as Prisma.InputJsonValue,
      },
    });

    if (result.success) {
      // SUCCESS
      log.info('Payment succeeded', { gatewayReference: result.gatewayReference });
      await this.transitionState(
        paymentId,
        PaymentStatus.PROCESSING,
        PaymentStatus.SUCCESS,
        currentVersion,
        {
          gatewayReference: result.gatewayReference,
          processedAt: new Date(),
        },
      );
    } else if (result.pendingWebhook) {
      // PENDING — result will come via webhook, don't transition yet
      log.info('Payment pending — awaiting webhook', {
        gatewayReference: result.gatewayReference,
      });
      // Update gateway reference but stay in PROCESSING
      await prisma.payment.update({
        where: { id: paymentId, version: currentVersion },
        data: { gatewayReference: result.gatewayReference || null },
      });
    } else {
      // FAILED
      log.warn('Payment failed', {
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      });
      await this.transitionState(
        paymentId,
        PaymentStatus.PROCESSING,
        PaymentStatus.FAILED,
        currentVersion,
        {
          errorCode: result.errorCode || null,
          errorMessage: result.errorMessage || null,
        },
      );

      // Check if we should retry
      const updatedPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
      if (updatedPayment && result.errorCode) {
        const canRetry =
          isRetryableError(result.errorCode) &&
          updatedPayment.retryCount < updatedPayment.maxRetries;

        if (!canRetry) {
          log.info('Payment permanently failed — non-retryable or max retries', {
            errorCode: result.errorCode,
            retryCount: updatedPayment.retryCount,
            maxRetries: updatedPayment.maxRetries,
          });
          await this.transitionState(
            paymentId,
            PaymentStatus.FAILED,
            PaymentStatus.PERMANENTLY_FAILED,
            updatedPayment.version,
          );
        }
        // If retryable, the retry service (Phase 7) will handle scheduling
      }
    }
  }

  /**
   * Get a single payment by ID with its event history.
   */
  async getPayment(paymentId: string): Promise<PaymentWithEvents> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        paymentEvents: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!payment) {
      throw new NotFoundError('Payment', paymentId);
    }

    return {
      ...this.toPaymentResponse(payment),
      events: payment.paymentEvents.map((e) => ({
        id: e.id,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        eventType: e.eventType,
        eventData: e.eventData as Record<string, unknown> | null,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  /**
   * List payments with pagination and filtering.
   */
  async listPayments(filters: PaymentListFilters): Promise<PaginatedResponse<PaymentResponse>> {
    const { page, limit, status, merchantId, fromDate, toDate } = filters;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.PaymentWhereInput = {};
    if (status) where.status = status;
    if (merchantId) where.merchantId = merchantId;
    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate) where.createdAt.gte = new Date(fromDate);
      if (toDate) where.createdAt.lte = new Date(toDate);
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.payment.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      data: payments.map((p) => this.toPaymentResponse(p)),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1,
      },
    };
  }

  /**
   * Cancel a payment (only if in CREATED or PENDING state).
   */
  async cancelPayment(paymentId: string): Promise<PaymentResponse> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment) {
      throw new NotFoundError('Payment', paymentId);
    }

    if (TERMINAL_STATES.has(payment.status as PaymentStatusType)) {
      throw new ConflictError(
        `Payment is already in terminal state '${payment.status}' and cannot be cancelled`,
      );
    }

    if (payment.status !== PaymentStatus.CREATED && payment.status !== PaymentStatus.PENDING) {
      throw new ConflictError(
        `Payment in '${payment.status}' state cannot be cancelled — only CREATED or PENDING payments can be cancelled`,
      );
    }

    const updated = await this.transitionState(
      paymentId,
      payment.status as PaymentStatusType,
      PaymentStatus.CANCELLED,
      payment.version,
      { reason: 'Cancelled by user' },
    );

    logger.info('Payment cancelled', { paymentId });
    return this.toPaymentResponse(updated);
  }

  /**
   * Transition payment state with optimistic locking and audit trail.
   * Runs outside a transaction — use transitionStateInTx for transaction contexts.
   */
  private async transitionState(
    paymentId: string,
    fromStatus: PaymentStatusType,
    toStatus: PaymentStatusType,
    expectedVersion: number,
    additionalData?: Record<string, unknown>,
  ) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      return this.transitionStateInTx(
        tx,
        paymentId,
        fromStatus,
        toStatus,
        expectedVersion,
        additionalData,
      );
    });
  }

  /**
   * Transition payment state within an existing transaction.
   * Validates the transition, uses optimistic locking, and creates an audit event.
   */
  private async transitionStateInTx(
    tx: Prisma.TransactionClient,
    paymentId: string,
    fromStatus: PaymentStatusType,
    toStatus: PaymentStatusType,
    expectedVersion: number,
    additionalData?: Record<string, unknown>,
  ) {
    // Validate state transition
    if (!isValidStateTransition(fromStatus, toStatus)) {
      throw new ConflictError(`Invalid state transition from '${fromStatus}' to '${toStatus}'`, {
        paymentId,
        fromStatus,
        toStatus,
      });
    }

    // Build update data
    const updateData: Prisma.PaymentUpdateInput = {
      status: toStatus,
      version: { increment: 1 },
    };

    if (additionalData?.gatewayReference) {
      updateData.gatewayReference = additionalData.gatewayReference as string;
    }
    if (additionalData?.processedAt) {
      updateData.processedAt = additionalData.processedAt as Date;
    }
    if (additionalData?.errorCode !== undefined) {
      updateData.errorCode = additionalData.errorCode as string | null;
    }
    if (additionalData?.errorMessage !== undefined) {
      updateData.errorMessage = additionalData.errorMessage as string | null;
    }
    if (toStatus === PaymentStatus.RETRY_SCHEDULED) {
      updateData.retryCount = { increment: 1 };
    }

    // Optimistic lock: only update if version matches
    try {
      const updated = await tx.payment.update({
        where: {
          id: paymentId,
          version: expectedVersion,
        },
        data: updateData,
      });

      // Create audit event
      await tx.paymentEvent.create({
        data: {
          id: generateId(),
          paymentId,
          fromStatus,
          toStatus,
          eventType: EventType.STATE_CHANGE,
          eventData: {
            ...additionalData,
            version: updated.version,
          },
        },
      });

      logger.debug('State transition', {
        paymentId,
        from: fromStatus,
        to: toStatus,
        version: updated.version,
      });

      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ConflictError(
          `Optimistic lock conflict — payment '${paymentId}' was modified concurrently`,
          { paymentId, expectedVersion },
        );
      }
      throw error;
    }
  }

  /**
   * Convert a Prisma Payment to a PaymentResponse DTO.
   */
  private toPaymentResponse(payment: {
    id: string;
    amount: Prisma.Decimal;
    currency: string;
    status: string;
    merchantId: string;
    customerEmail: string;
    description: string | null;
    gatewayReference: string | null;
    retryCount: number;
    maxRetries: number;
    errorCode: string | null;
    errorMessage: string | null;
    metadata: Prisma.JsonValue;
    processedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): PaymentResponse {
    return {
      id: payment.id,
      amount: payment.amount.toString(),
      currency: payment.currency,
      status: payment.status as PaymentStatusType,
      merchantId: payment.merchantId,
      customerEmail: payment.customerEmail,
      description: payment.description,
      gatewayReference: payment.gatewayReference,
      retryCount: payment.retryCount,
      maxRetries: payment.maxRetries,
      errorCode: payment.errorCode,
      errorMessage: payment.errorMessage,
      metadata: payment.metadata as Record<string, unknown> | null,
      processedAt: payment.processedAt?.toISOString() || null,
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
    };
  }
}

export const paymentService = new PaymentService();
