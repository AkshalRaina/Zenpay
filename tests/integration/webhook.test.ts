import request from 'supertest';
import { app } from '../../src/app';
import crypto from 'crypto';
import { prisma } from '../../src/config/database';
import { config } from '../../src/config';
import { PaymentStatus } from '../../src/utils/constants';

describe('Webhook Integration', () => {
  let paymentId: string;

  beforeAll(async () => {
    // Create a dummy payment to receive webhooks for
    const payment = await prisma.payment.create({
      data: {
        id: crypto.randomUUID(),
        amount: '100',
        currency: 'USD',
        merchantId: 'merch_web',
        status: PaymentStatus.PROCESSING,
        customerEmail: 'web@example.com',
      },
    });
    paymentId = payment.id;
  });

  afterAll(async () => {
    // Cleanup
    await prisma.paymentEvent.deleteMany({ where: { paymentId } });
    await prisma.payment.delete({ where: { id: paymentId } });
  });

  it('should process a valid success webhook', async () => {
    const payload = JSON.stringify({
      eventId: 'evt_success_123',
      paymentId,
      status: 'success',
      gatewayReference: 'gw_success_123',
      timestamp: new Date().toISOString(),
    });

    const signature = 'sha256=' + crypto.createHmac('sha256', config.WEBHOOK_SECRET).update(payload).digest('hex');

    const response = await request(app)
      .post('/api/v1/webhooks/gateway')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .send(payload)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Webhook processed successfully');

    // Verify DB update
    const updated = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(updated?.status).toBe(PaymentStatus.SUCCESS);
    expect(updated?.gatewayReference).toBe('gw_success_123');
  });

  it('should reject a webhook with invalid signature', async () => {
    const payload = JSON.stringify({
      eventId: 'evt_invalid_sig',
      paymentId,
      status: 'success',
      gatewayReference: 'gw_success_123',
      timestamp: new Date().toISOString(),
    });

    const response = await request(app)
      .post('/api/v1/webhooks/gateway')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', 'sha256=invalid-signature-123')
      .send(payload)
      .expect(401);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('should ignore duplicate webhooks returning 200', async () => {
    // The previous test already transitioned it to SUCCESS.
    // Transitioning from SUCCESS -> SUCCESS is invalid, but webhook logic should just ignore it and return 200 to acknowledge.
    const payload = JSON.stringify({
      eventId: 'evt_success_123',
      paymentId,
      status: 'success',
      gatewayReference: 'gw_success_123',
      timestamp: new Date().toISOString(),
    });

    const signature = 'sha256=' + crypto.createHmac('sha256', config.WEBHOOK_SECRET).update(payload).digest('hex');

    const response = await request(app)
      .post('/api/v1/webhooks/gateway')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signature)
      .send(payload)
      .expect(200);

    expect(response.body.message).toBe('Webhook ignored (invalid state transition or duplicate)');
  });
});
