import { Router } from 'express';
import { webhookController } from '../controllers/webhook.controller';

const router = Router();

/**
 * Webhook routes.
 *
 * POST /gateway  → Receive gateway callback
 */
router.post('/gateway', webhookController.handleGatewayWebhook.bind(webhookController));

export { router as webhookRoutes };
