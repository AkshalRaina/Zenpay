import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';
import { validate } from '../middleware/validator';
import { idempotency } from '../middleware/idempotency';
import { createPaymentSchema } from '../middleware/schemas';

const router = Router();

/**
 * Payment routes.
 *
 * POST   /             → Create a new payment (validated + idempotent)
 * GET    /:id          → Get payment by ID
 * GET    /             → List payments (paginated, filtered)
 * POST   /:id/cancel   → Cancel a pending payment
 */

// Create payment — with validation and idempotency middleware
router.post(
  '/',
  validate(createPaymentSchema),
  idempotency,
  paymentController.initiatePayment.bind(paymentController),
);

// Get payment by ID
router.get('/:id', paymentController.getPayment.bind(paymentController));

// List payments
router.get('/', paymentController.listPayments.bind(paymentController));

// Cancel payment
router.post('/:id/cancel', paymentController.cancelPayment.bind(paymentController));

export { router as paymentRoutes };
