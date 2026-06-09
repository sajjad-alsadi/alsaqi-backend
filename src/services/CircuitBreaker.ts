import axios, { AxiosError } from 'axios';
import { db } from '../db/index.js';
import logger from '../utils/logger.js';

/**
 * Circuit Breaker States
 */
export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Configuration for the circuit breaker
 */
export interface CircuitBreakerConfig {
  /** Maximum retry attempts before giving up (default: 3) */
  maxRetries: number;
  /** Initial backoff delay in ms (default: 1000) */
  initialBackoffMs: number;
  /** Number of consecutive failures to open the circuit (default: 5) */
  failureThreshold: number;
  /** Time window in ms for counting failures (default: 60000) */
  failureWindowMs: number;
  /** Health probe interval in ms while circuit is open (default: 30000) */
  healthProbeIntervalMs: number;
  /** Timeout for health probe in ms (default: 5000) */
  healthProbeTimeoutMs: number;
  /** Request timeout in ms (default: 5000) */
  requestTimeoutMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxRetries: 3,
  initialBackoffMs: 1000,
  failureThreshold: 5,
  failureWindowMs: 60000,
  healthProbeIntervalMs: 30000,
  healthProbeTimeoutMs: 5000,
  requestTimeoutMs: 5000,
};

/**
 * Dead Letter Queue entry
 */
export interface DeadLetterEntry {
  event_type: string;
  payload: string;
  failure_reason: string;
  retry_count: number;
}

/**
 * Circuit Breaker with retry logic and dead letter queue for external service calls.
 *
 * Implements:
 * - Retry with exponential backoff (1s start, 3 max attempts)
 * - Circuit breaker: opens after 5 consecutive failures in 60s window
 * - While open: stores events in dead_letter_queue, returns success for core operation
 * - Health probe every 30s while open; closes after 1 successful probe within 5s
 */
export class CircuitBreaker {
  private _state: CircuitState = CircuitState.CLOSED;
  private _failures: number[] = []; // timestamps of consecutive failures
  private _consecutiveFailures = 0;
  private _healthProbeTimer: ReturnType<typeof setInterval> | null = null;
  private _config: CircuitBreakerConfig;
  private _serviceUrl: string | null;
  private _serviceHeaders: Record<string, string>;

  constructor(
    serviceUrl: string | null,
    headers: Record<string, string> = {},
    config: Partial<CircuitBreakerConfig> = {}
  ) {
    this._serviceUrl = serviceUrl;
    this._serviceHeaders = headers;
    this._config = { ...DEFAULT_CONFIG, ...config };
  }

  get state(): CircuitState {
    return this._state;
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  /**
   * Execute an external service call with retry and circuit breaker logic.
   * 
   * @param eventType - The type of event being sent
   * @param payload - The event payload
   * @returns true if the event was sent successfully, false if it was stored in the dead letter queue
   */
  async call(eventType: string, payload: any): Promise<boolean> {
    // If service URL is not configured, skip silently
    if (!this._serviceUrl) {
      logger.warn(`[CircuitBreaker] Service URL not configured. Skipping event: ${eventType}`);
      return true;
    }

    // If circuit is open, store in dead letter queue immediately
    if (this._state === CircuitState.OPEN) {
      logger.warn(`[CircuitBreaker] Circuit is OPEN. Storing event in dead letter queue: ${eventType}`);
      await this.storeInDeadLetterQueue(eventType, payload, 'Circuit breaker is open');
      return false;
    }

    // Attempt the call with retries
    let lastError = '';
    for (let attempt = 1; attempt <= this._config.maxRetries; attempt++) {
      try {
        await this.executeRequest(eventType, payload);
        // Success - reset failure count
        this._consecutiveFailures = 0;
        this._failures = [];
        
        // If we were in HALF_OPEN, close the circuit
        if (this._state === CircuitState.HALF_OPEN) {
          this.closeCircuit();
        }
        
        return true;
      } catch (error: any) {
        lastError = this.extractErrorReason(error);
        logger.warn(
          `[CircuitBreaker] Attempt ${attempt}/${this._config.maxRetries} failed for event ${eventType}: ${lastError}`
        );

        // If not the last attempt, wait with exponential backoff
        if (attempt < this._config.maxRetries) {
          const backoffMs = this._config.initialBackoffMs * Math.pow(2, attempt - 1);
          await this.sleep(backoffMs);
        }
      }
    }

    // All retries exhausted - record failure
    this.recordFailure();
    
    // Store in dead letter queue
    await this.storeInDeadLetterQueue(eventType, payload, lastError);
    
    logger.error(
      `[CircuitBreaker] All ${this._config.maxRetries} attempts failed for event ${eventType}. Stored in dead letter queue.`
    );

    return false;
  }

  /**
   * Execute the actual HTTP request to the external service.
   */
  private async executeRequest(eventType: string, payload: any): Promise<void> {
    const response = await axios.post(
      this._serviceUrl!,
      {
        event: eventType,
        timestamp: new Date().toISOString(),
        data: payload,
      },
      {
        headers: this._serviceHeaders,
        timeout: this._config.requestTimeoutMs,
      }
    );

    // Treat 5xx responses as failures
    if (response.status >= 500) {
      throw new Error(`Server error: HTTP ${response.status}`);
    }
  }

  /**
   * Record a failure and check if the circuit should open.
   */
  private recordFailure(): void {
    const now = Date.now();
    this._consecutiveFailures++;
    this._failures.push(now);

    // Remove failures outside the window
    const windowStart = now - this._config.failureWindowMs;
    this._failures = this._failures.filter(t => t >= windowStart);

    // Check if we should open the circuit
    if (this._consecutiveFailures >= this._config.failureThreshold) {
      this.openCircuit();
    }
  }

  /**
   * Open the circuit breaker - stop calling the external service.
   */
  private openCircuit(): void {
    if (this._state === CircuitState.OPEN) return;

    this._state = CircuitState.OPEN;
    logger.error(
      `[CircuitBreaker] Circuit OPENED after ${this._consecutiveFailures} consecutive failures.`
    );

    // Start health probing
    this.startHealthProbe();
  }

  /**
   * Close the circuit breaker - resume normal operation.
   */
  private closeCircuit(): void {
    this._state = CircuitState.CLOSED;
    this._consecutiveFailures = 0;
    this._failures = [];
    this.stopHealthProbe();
    logger.info('[CircuitBreaker] Circuit CLOSED. External service is healthy.');
  }

  /**
   * Start periodic health probes while the circuit is open.
   */
  private startHealthProbe(): void {
    this.stopHealthProbe(); // Clear any existing timer

    this._healthProbeTimer = setInterval(async () => {
      await this.performHealthProbe();
    }, this._config.healthProbeIntervalMs);
  }

  /**
   * Stop the health probe timer.
   */
  private stopHealthProbe(): void {
    if (this._healthProbeTimer) {
      clearInterval(this._healthProbeTimer);
      this._healthProbeTimer = null;
    }
  }

  /**
   * Perform a single health probe to the external service.
   * If successful within the timeout, close the circuit.
   */
  async performHealthProbe(): Promise<boolean> {
    if (!this._serviceUrl) return false;

    try {
      this._state = CircuitState.HALF_OPEN;
      logger.info('[CircuitBreaker] Performing health probe...');

      await axios.get(this._serviceUrl, {
        headers: this._serviceHeaders,
        timeout: this._config.healthProbeTimeoutMs,
      });

      // Probe succeeded - close the circuit
      this.closeCircuit();
      return true;
    } catch (error: any) {
      // Probe failed - keep circuit open
      this._state = CircuitState.OPEN;
      logger.warn(`[CircuitBreaker] Health probe failed: ${this.extractErrorReason(error)}`);
      return false;
    }
  }

  /**
   * Store a failed event in the dead_letter_queue table.
   */
  async storeInDeadLetterQueue(
    eventType: string,
    payload: any,
    failureReason: string
  ): Promise<void> {
    try {
      const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
      await db.prepare(
        `INSERT INTO dead_letter_queue (event_type, payload, failure_reason, retry_count) VALUES (?, ?, ?, ?)`
      ).run(eventType, payloadStr, failureReason, 0);
      
      logger.info(`[CircuitBreaker] Event stored in dead letter queue: ${eventType}`);
    } catch (dbError: any) {
      // If we can't even store in the DLQ, log to stderr but don't throw
      logger.error(
        `[CircuitBreaker] CRITICAL: Failed to store event in dead letter queue: ${dbError.message}`
      );
    }
  }

  /**
   * Extract a human-readable error reason from an error object.
   */
  private extractErrorReason(error: any): string {
    if (axios.isAxiosError(error)) {
      const axiosErr = error as AxiosError;
      if (axiosErr.code === 'ECONNABORTED' || axiosErr.code === 'ETIMEDOUT') {
        return `Connection timeout (>${this._config.requestTimeoutMs}ms)`;
      }
      if (axiosErr.code === 'ECONNREFUSED') {
        return 'Connection refused';
      }
      if (axiosErr.code === 'ENOTFOUND') {
        return 'Host not found';
      }
      if (axiosErr.response) {
        return `HTTP ${axiosErr.response.status}: ${axiosErr.response.statusText}`;
      }
      return `Network error: ${axiosErr.message}`;
    }
    return error?.message || 'Unknown error';
  }

  /**
   * Check if an error is a retryable failure (5xx, timeout, network error).
   */
  static isRetryableError(error: any): boolean {
    if (axios.isAxiosError(error)) {
      const axiosErr = error as AxiosError;
      // Network errors (timeout, connection refused, etc.)
      if (!axiosErr.response) return true;
      // 5xx server errors
      if (axiosErr.response.status >= 500) return true;
    }
    return false;
  }

  /**
   * Utility sleep function for backoff delays.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean up resources (stop health probe timer).
   */
  destroy(): void {
    this.stopHealthProbe();
  }

  /**
   * Reset the circuit breaker to its initial state (useful for testing).
   */
  reset(): void {
    this._state = CircuitState.CLOSED;
    this._consecutiveFailures = 0;
    this._failures = [];
    this.stopHealthProbe();
  }
}

// Singleton instance for the n8n webhook service
let n8nCircuitBreaker: CircuitBreaker | null = null;

/**
 * Get or create the singleton circuit breaker instance for n8n webhook calls.
 */
export function getN8nCircuitBreaker(): CircuitBreaker {
  if (!n8nCircuitBreaker) {
    const webhookUrl = process.env.N8N_WEBHOOK_URL || null;
    const apiKey = process.env.N8N_WEBHOOK_API_KEY || null;

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['X-N8N-API-KEY'] = apiKey;
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    n8nCircuitBreaker = new CircuitBreaker(webhookUrl, headers);
  }
  return n8nCircuitBreaker;
}

/**
 * Reset the singleton instance (useful for testing).
 */
export function resetN8nCircuitBreaker(): void {
  if (n8nCircuitBreaker) {
    n8nCircuitBreaker.destroy();
    n8nCircuitBreaker = null;
  }
}
