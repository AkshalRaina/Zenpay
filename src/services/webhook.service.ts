import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config';
import { withLock, paymentLockKey } from '../utils/distributedLock';
import { createChildLogger } from '../utils/logger';
import { verifyWebhookSignature, isValidStateTransition, generateId } from '../utils/helpers';
import { PaymentStatus, PaymentStatusType, TERMINAL_STATES, EventType } from '../utils/constants';
import { UnauthorizedError } from '../utils/errors';
import { WebhookPayload } from '../types';

/**
 * Webhook service.
 *
 * Processes incoming gateway webhook callbacks with:
 * - HMAC signature verification
 * - Duplicate detection (event_id dedup)
 * - Distributed locking (prevent race conditions)
 * - State transition validation (reject conflicting updates)
 * - Atomic DB updates (transaction)
 */
export class WebhookService {
  /**
   * Process an incoming webhook callback.
   *
   * @param payload - Parsed webhook body
   * @param signature - X-Webhook-Signature header value
   */
  async processWebhook(
    payload: WebhookPayload,
    signature: string,
  ): Promise<{ status: 'processed' | 'ignored' }> {
    const log = createChildLogger({
      paymentId: payload.paymentId,
      eventId: payload.eventId,
    });

    log.info('Processing webhook', {
      status: payload.status,
      gatewayReference: payload.gatewayReference,
    });

    // 1. Verify signature
    const payloadString = JSON.stringify(payload);
    if (!verifyWebhookSignature(payloadString, signature, config.WEBHOOK_SECRET)) {
      log.warn('Webhook signature verification failed');
      throw new UnauthorizedError('Invalid webhook signature');
    }

    // 2. Check for duplicate event
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { eventId: payload.eventId },
    });

    if (existingEvent) {
      log.info('Duplicate webhook — already processed', {
        existingStatus: existingEvent.status,
      });

      // Record as duplicate for audit
      await prisma.webhookEvent.create({
        data: {
          id: generateId(),
          paymentId: payload.paymentId,
          eventId: `${payload.eventId}_dup_${Date.now()}`,
          eventType: 'payment.update',
          payload: payload as unknown as Prisma.InputJsonValue,
          signature,
          status: 'DUPLICATE',
        },
      });

      return { status: 'ignored' }; // Skip processing
    }

    // 3. Acquire lock and process
    return withLock(paymentLockKey(payload.paymentId), config.LOCK_TTL_MS, async () => {
      // 4. Fetch payment
      const payment = await prisma.payment.findUnique({
        where: { id: payload.paymentId },
      });

      if (!payment) {
        log.error('Payment not found for webhook');

        await this.recordWebhookEvent(payload, signature, 'REJECTED');
        return { status: 'ignored' };
      }

      // 5. Check if payment is already in a terminal state
      if (TERMINAL_STATES.has(payment.status as PaymentStatusType)) {
        log.warn('Webhook for terminal-state payment — rejecting', {
          currentStatus: payment.status,
          webhookStatus: payload.status,
        });

        await this.recordWebhookEvent(payload, signature, 'REJECTED');
        return { status: 'ignored' };
      }

      // 6. Determine target state
      const targetStatus =
        payload.status === 'success' ? PaymentStatus.SUCCESS : PaymentStatus.FAILED;

      // 7. Validate state transition
      const currentStatus = payment.status as PaymentStatusType;
      if (!isValidStateTransition(currentStatus, targetStatus)) {
        log.warn('Invalid state transition from webhook', {
          currentStatus,
          targetStatus,
        });

        await this.recordWebhookEvent(payload, signature, 'REJECTED');
        return { status: 'ignored' };
      }

      // 8. Update payment state and record webhook (atomic)
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Update payment
        const updateData: Prisma.PaymentUpdateInput = {
          status: targetStatus,
          gatewayReference: payload.gatewayReference,
          version: { increment: 1 },
        };

        if (targetStatus === PaymentStatus.SUCCESS) {
          updateData.processedAt = new Date();
        }

        if (payload.errorCode) {
          updateData.errorCode = payload.errorCode;
          updateData.errorMessage = payload.errorMessage || null;
        }

        await tx.payment.update({
          where: { id: payload.paymentId, version: payment.version },
          data: updateData,
        });

        // Record payment event
        await tx.paymentEvent.create({
          data: {
            id: generateId(),
            paymentId: payload.paymentId,
            fromStatus: currentStatus,
            toStatus: targetStatus,
            eventType: EventType.WEBHOOK_RECEIVED,
            eventData: {
              eventId: payload.eventId,
              gatewayReference: payload.gatewayReference,
              webhookTimestamp: payload.timestamp,
            },
          },
        });

        // Record webhook event
        await tx.webhookEvent.create({
          data: {
            id: generateId(),
            paymentId: payload.paymentId,
            eventId: payload.eventId,
            eventType: 'payment.update',
            payload: payload as unknown as Prisma.InputJsonValue,
            signature,
            status: 'PROCESSED',
          },
        });
      });

      log.info('Webhook processed successfully', {
        from: currentStatus,
        to: targetStatus,
      });
      return { status: 'processed' };
    });
  }

  /**
   * Record a webhook event (for rejected/duplicate scenarios outside a transaction).
   */
  private async recordWebhookEvent(
    payload: WebhookPayload,
    signature: string,
    status: 'PROCESSED' | 'REJECTED' | 'DUPLICATE',
  ): Promise<void> {
    await prisma.webhookEvent.create({
      data: {
        id: generateId(),
        paymentId: payload.paymentId,
        eventId: status === 'DUPLICATE' ? `${payload.eventId}_dup_${Date.now()}` : payload.eventId,
        eventType: 'payment.update',
        payload: payload as unknown as Prisma.InputJsonValue,
        signature,
        status,
      },
    });
  }
}

export const webhookService = new WebhookService();
