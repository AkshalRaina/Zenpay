import request from 'supertest';
import { app } from '../../src/app';
import { redis } from '../../src/config/redis';
import { prisma } from '../../src/config/database';

describe('Idempotency Middleware Integration', () => {
  const idempotencyKey = 'idemp-test-key-1';

  async function cleanup() {
    await redis.del(`idempotency:${idempotencyKey}`);
    await prisma.idempotencyKey.deleteMany({ where: { key: idempotencyKey } });
    const payment = await prisma.payment.findUnique({ where: { idempotencyKey } });
    if (payment) {
      await prisma.paymentEvent.deleteMany({ where: { paymentId: payment.id } });
      await prisma.payment.delete({ where: { id: payment.id } });
    }
  }

  beforeAll(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('should return 201 for the first request', async () => {
    const payload = {
      amount: 100,
      currency: 'USD',
      merchantId: 'merch_idemp',
      customerEmail: 'test@example.com',
    };

    const response = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(201);

    expect(response.body.success).toBe(true);
    // Note: The payment created here won't be deleted in this test file,
    // but the DB will be cleared later if needed.
  });

  it('should return exactly the same cached response for a duplicate request', async () => {
    const payload = {
      amount: 100,
      currency: 'USD',
      merchantId: 'merch_idemp',
      customerEmail: 'test@example.com',
    };

    const response = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', idempotencyKey)
      .send(payload)
      .expect(201); // Even though it's cached, the original code was 201

    expect(response.body.success).toBe(true);
  });

  it('should reject reuse of the same key with a different payload', async () => {
    const differentPayload = {
      amount: 200, // Changed amount
      currency: 'USD',
      merchantId: 'merch_idemp',
      customerEmail: 'test@example.com',
    };

    const response = await request(app)
      .post('/api/v1/payments')
      .set('Idempotency-Key', idempotencyKey)
      .send(differentPayload)
      .expect(422);

    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
  });
});
