import { Request, Response, NextFunction } from 'express';
import { webhookService } from '../services/webhook.service';
import { WebhookPayload } from '../types';
import { StatusCodes } from 'http-status-codes';

/**
 * Webhook controller — receives gateway callbacks.
 */
export class WebhookController {
  /**
   * POST /api/v1/webhooks/gateway
   * Handle incoming gateway webhook callback.
   */
  async handleGatewayWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const payload: WebhookPayload = req.body;
      const signature = req.headers['x-webhook-signature'] as string;

      if (!signature) {
        res.status(StatusCodes.UNAUTHORIZED).json({
          success: false,
          error: {
            code: 'MISSING_SIGNATURE',
            message: 'X-Webhook-Signature header is required',
          },
        });
        return;
      }

      const result = await webhookService.processWebhook(payload, signature);

      const message =
        result.status === 'ignored'
          ? 'Webhook ignored (invalid state transition or duplicate)'
          : 'Webhook processed successfully';

      // Always return 200 to acknowledge receipt
      res.status(StatusCodes.OK).json({
        success: true,
        data: { received: true },
        message,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const webhookController = new WebhookController();
