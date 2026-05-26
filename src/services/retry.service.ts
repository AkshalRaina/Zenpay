import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { paymentProducer } from '../queue/payment.producer';
import { createChildLogger } from '../utils/logger';
import { calculateBackoffDelay, isRetryableError, generateId } from '../utils/helpers';
import { PaymentStatus, EventType } from '../utils/constants';

/**
 * Retry service.
 *
 * Handles retry scheduling logic — determines if a payment should be retried,
 * calculates backoff delay, transitions state, and enqueues retry jobs.
 */
export class RetryService {
  /**
   * Handle a failed payment processing attempt.
   * Called by the process worker when a payment fails.
   *
   * Decides whether to schedule a retry or mark as permanently failed.
   */
  async handleFailedProcessing(paymentId: string): Promise<void> {
    const log = createChildLogger({ paymentId });

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment) {
      log.error('Payment not found for retry handling');
      return;
    }

    // Only handle payments in FAILED state
    if (payment.status !== PaymentStatus.FAILED) {
      log.debug('Payment not in FAILED state, skipping retry', {
        status: payment.status,
      });
      return;
    }

    const canRetry =
      payment.errorCode &&
      isRetryableError(payment.errorCode) &&
      payment.retryCount < payment.maxRetries;

    if (canRetry) {
      await this.scheduleRetry(paymentId, payment.retryCount);
    } else {
      log.info('Payment cannot be retried — marking as permanently failed', {
        errorCode: payment.errorCode,
        retryCount: payment.retryCount,
        maxRetries: payment.maxRetries,
      });

      // Transition to PERMANENTLY_FAILED
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.payment.update({
          where: { id: paymentId, version: payment.version },
          data: {
            status: PaymentStatus.PERMANENTLY_FAILED,
            version: { increment: 1 },
          },
        });

        await tx.paymentEvent.create({
          data: {
            id: generateId(),
            paymentId,
            fromStatus: PaymentStatus.FAILED,
            toStatus: PaymentStatus.PERMANENTLY_FAILED,
            eventType: EventType.STATE_CHANGE,
            eventData: {
              reason: payment.errorCode
                ? `Non-retryable error: ${payment.errorCode}`
                : `Max retries (${payment.maxRetries}) exceeded`,
            },
          },
        });
      });
    }
  }

  /**
   * Schedule a retry for a failed payment.
   * Calculates backoff delay, transitions to RETRY_SCHEDULED, and enqueues.
   */
  async scheduleRetry(paymentId: string, currentAttempt: number): Promise<void> {
    const log = createChildLogger({ paymentId });
    const delay = calculateBackoffDelay(currentAttempt);

    log.info('Scheduling retry', {
      attempt: currentAttempt + 1,
      delayMs: Math.round(delay),
    });

    // Transition to RETRY_SCHEDULED
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment || payment.status !== PaymentStatus.FAILED) {
      log.warn('Cannot schedule retry — payment not in FAILED state');
      return;
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.payment.update({
        where: { id: paymentId, version: payment.version },
        data: {
          status: PaymentStatus.RETRY_SCHEDULED,
          retryCount: { increment: 1 },
          version: { increment: 1 },
        },
      });

      await tx.paymentEvent.create({
        data: {
          id: generateId(),
          paymentId,
          fromStatus: PaymentStatus.FAILED,
          toStatus: PaymentStatus.RETRY_SCHEDULED,
          eventType: EventType.RETRY_SCHEDULED,
          eventData: {
            attempt: currentAttempt + 1,
            delayMs: Math.round(delay),
            nextRetryAt: new Date(Date.now() + delay).toISOString(),
          },
        },
      });
    });

    // Enqueue the retry job with delay
    await paymentProducer.enqueueRetry(paymentId, currentAttempt + 1, Math.round(delay));
  }

  /**
   * Execute a retry — transition from RETRY_SCHEDULED → PENDING and re-enqueue for processing.
   * Called by the retry worker when the backoff delay has elapsed.
   */
  async executeRetry(paymentId: string): Promise<void> {
    const log = createChildLogger({ paymentId });

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment) {
      log.error('Payment not found for retry execution');
      return;
    }

    if (payment.status !== PaymentStatus.RETRY_SCHEDULED) {
      log.warn('Payment not in RETRY_SCHEDULED state, skipping', {
        status: payment.status,
      });
      return;
    }

    // Transition to PENDING
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.payment.update({
        where: { id: paymentId, version: payment.version },
        data: {
          status: PaymentStatus.PENDING,
          version: { increment: 1 },
        },
      });

      await tx.paymentEvent.create({
        data: {
          id: generateId(),
          paymentId,
          fromStatus: PaymentStatus.RETRY_SCHEDULED,
          toStatus: PaymentStatus.PENDING,
          eventType: EventType.STATE_CHANGE,
          eventData: {
            reason: 'Retry delay elapsed — re-enqueued for processing',
          },
        },
      });
    });

    // Re-enqueue for processing
    await paymentProducer.enqueuePayment(paymentId);
    log.info('Retry executed — payment re-enqueued for processing');
  }
}

export const retryService = new RetryService();
