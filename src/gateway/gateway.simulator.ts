import {
  GatewayPaymentRequest,
  GatewayPaymentResponse,
  GatewaySimulatorConfig,
} from './gateway.types';
import { GatewayErrorCode, GatewayErrorCodeType } from '../utils/constants';
import { GatewayError } from '../utils/errors';
import { generateId, sleep } from '../utils/helpers';
import { logger } from '../utils/logger';

/**
 * Default probability distribution for gateway outcomes.
 * Sum should equal 1.0.
 */
const DEFAULT_CONFIG: GatewaySimulatorConfig = {
  instantSuccessRate: 0.4, // 40% — instant success
  delayedSuccessRate: 0.15, // 15% — delayed success (2-5s)
  instantFailureRate: 0.2, // 20% — instant failure
  timeoutRate: 0.1, // 10% — timeout (no response)
  networkErrorRate: 0.1, // 10% — network error (throws)
  webhookOnlyRate: 0.05, // 5%  — pending + webhook later
  minDelayMs: 2000,
  maxDelayMs: 5000,
  timeoutMs: 10000,
};

/**
 * Non-retryable failure error codes with descriptive messages.
 */
const FAILURE_SCENARIOS: { code: GatewayErrorCodeType; message: string }[] = [
  { code: GatewayErrorCode.INSUFFICIENT_FUNDS, message: 'Card has insufficient balance' },
  { code: GatewayErrorCode.CARD_EXPIRED, message: 'Card has expired' },
  { code: GatewayErrorCode.FRAUD_DETECTED, message: 'Transaction flagged by fraud prevention' },
  { code: GatewayErrorCode.INTERNAL_ERROR, message: 'Gateway internal server error' },
];

/**
 * Simulates an external payment gateway with realistic behavior.
 *
 * Produces randomized outcomes based on configurable probabilities:
 * - Instant success, delayed success, instant failure
 * - Timeout (hangs), network error (throws), webhook-only (pending)
 *
 * This is designed to exercise all edge cases in the payment processing flow.
 */
export class GatewaySimulator {
  private readonly config: GatewaySimulatorConfig;
  private webhookCallback?: (paymentId: string, success: boolean, reference: string) => void;

  constructor(config: Partial<GatewaySimulatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.validateConfig();
  }

  /**
   * Register a callback function for async webhook delivery.
   * Called when the gateway returns a "pending" status.
   */
  onWebhook(callback: (paymentId: string, success: boolean, reference: string) => void): void {
    this.webhookCallback = callback;
  }

  /**
   * Process a payment through the simulated gateway.
   *
   * @throws GatewayError on gateway-level failures
   * @throws Error on network-level failures (simulated)
   */
  async processPayment(request: GatewayPaymentRequest): Promise<GatewayPaymentResponse> {
    const startTime = Date.now();
    const gatewayReference = `gw_${generateId().replace(/-/g, '').slice(0, 16)}`;

    logger.info('Gateway: Processing payment', {
      paymentId: request.paymentId,
      amount: request.amount,
      currency: request.currency,
    });

    const scenario = this.selectScenario();

    switch (scenario) {
      case 'instant_success':
        return this.handleInstantSuccess(gatewayReference, startTime);

      case 'delayed_success':
        return this.handleDelayedSuccess(gatewayReference, startTime);

      case 'instant_failure':
        return this.handleInstantFailure(gatewayReference, startTime);

      case 'timeout':
        return this.handleTimeout(request.paymentId);

      case 'network_error':
        return this.handleNetworkError(request.paymentId);

      case 'webhook_only':
        return this.handleWebhookOnly(request.paymentId, gatewayReference, startTime);

      default:
        return this.handleInstantSuccess(gatewayReference, startTime);
    }
  }

  /**
   * Select a scenario based on weighted probabilities.
   */
  private selectScenario(): string {
    const rand = Math.random();
    let cumulative = 0;

    const scenarios: [string, number][] = [
      ['instant_success', this.config.instantSuccessRate],
      ['delayed_success', this.config.delayedSuccessRate],
      ['instant_failure', this.config.instantFailureRate],
      ['timeout', this.config.timeoutRate],
      ['network_error', this.config.networkErrorRate],
      ['webhook_only', this.config.webhookOnlyRate],
    ];

    for (const [name, probability] of scenarios) {
      cumulative += probability;
      if (rand < cumulative) {
        return name;
      }
    }

    return 'instant_success'; // Fallback
  }

  /**
   * Instant success — gateway responds immediately.
   */
  private handleInstantSuccess(
    gatewayReference: string,
    startTime: number,
  ): GatewayPaymentResponse {
    logger.debug('Gateway: Instant success');
    return {
      success: true,
      gatewayReference,
      status: 'success',
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Delayed success — gateway responds after a random delay (2-5s).
   */
  private async handleDelayedSuccess(
    gatewayReference: string,
    startTime: number,
  ): Promise<GatewayPaymentResponse> {
    const delay =
      this.config.minDelayMs + Math.random() * (this.config.maxDelayMs - this.config.minDelayMs);

    logger.debug('Gateway: Delayed success', { delayMs: Math.round(delay) });
    await sleep(delay);

    return {
      success: true,
      gatewayReference,
      status: 'success',
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Instant failure — gateway returns an error immediately.
   */
  private handleInstantFailure(
    gatewayReference: string,
    startTime: number,
  ): GatewayPaymentResponse {
    const failure = FAILURE_SCENARIOS[Math.floor(Math.random() * FAILURE_SCENARIOS.length)];

    logger.debug('Gateway: Instant failure', { errorCode: failure.code });
    return {
      success: false,
      gatewayReference,
      status: 'failed',
      errorCode: failure.code,
      errorMessage: failure.message,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Timeout — gateway doesn't respond within the timeout window.
   */
  private async handleTimeout(paymentId: string): Promise<never> {
    logger.debug('Gateway: Simulating timeout', { paymentId });
    await sleep(this.config.timeoutMs + 1000); // Exceed timeout

    // This should be caught by the caller's timeout logic
    throw new GatewayError('Gateway request timed out', GatewayErrorCode.GATEWAY_TIMEOUT, true);
  }

  /**
   * Network error — connection fails entirely.
   */
  private handleNetworkError(paymentId: string): never {
    logger.debug('Gateway: Simulating network error', { paymentId });
    throw new GatewayError(
      'Failed to connect to payment gateway',
      GatewayErrorCode.NETWORK_ERROR,
      true,
    );
  }

  /**
   * Webhook only — gateway returns "pending" and sends result via webhook later.
   */
  private async handleWebhookOnly(
    paymentId: string,
    gatewayReference: string,
    startTime: number,
  ): Promise<GatewayPaymentResponse> {
    logger.debug('Gateway: Webhook-only mode', { paymentId });

    // Schedule async webhook delivery (1-3 seconds later)
    if (this.webhookCallback) {
      const delay = 1000 + Math.random() * 2000;
      const success = Math.random() > 0.3; // 70% success via webhook

      setTimeout(() => {
        logger.info('Gateway: Sending async webhook', {
          paymentId,
          success,
          gatewayReference,
        });
        if (this.webhookCallback) {
          this.webhookCallback(paymentId, success, gatewayReference);
        }
      }, delay);
    }

    return {
      success: false,
      gatewayReference,
      status: 'pending',
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Validate that probability rates sum to approximately 1.0.
   */
  private validateConfig(): void {
    const total =
      this.config.instantSuccessRate +
      this.config.delayedSuccessRate +
      this.config.instantFailureRate +
      this.config.timeoutRate +
      this.config.networkErrorRate +
      this.config.webhookOnlyRate;

    if (Math.abs(total - 1.0) > 0.01) {
      logger.warn('Gateway simulator probability rates do not sum to 1.0', {
        total,
        rates: {
          instantSuccess: this.config.instantSuccessRate,
          delayedSuccess: this.config.delayedSuccessRate,
          instantFailure: this.config.instantFailureRate,
          timeout: this.config.timeoutRate,
          networkError: this.config.networkErrorRate,
          webhookOnly: this.config.webhookOnlyRate,
        },
      });
    }
  }
}

/**
 * Singleton gateway simulator instance for the application.
 */
export const gatewaySimulator = new GatewaySimulator();
