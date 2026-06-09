import logger from './logger.js';
import { getN8nCircuitBreaker } from '../services/CircuitBreaker.js';

/**
 * N8n Webhook Integration Service
 * 
 * This service sends automation events to an n8n workflow engine.
 * It is OPTIONAL and gracefully degrades if N8N_WEBHOOK_URL is not configured.
 * 
 * For air-gapped deployments: Leave N8N_WEBHOOK_URL unset and this service
 * will silently skip all events without affecting application functionality.
 * 
 * For connected deployments: Set N8N_WEBHOOK_URL to your internal n8n instance
 * (must be on the same network, not external internet).
 * 
 * Uses CircuitBreaker for retry logic, exponential backoff, and dead letter queue
 * to ensure graceful degradation when the external service is unavailable.
 */
export class N8nService {
  static async sendEvent(eventName: string, payload: any) {
    const circuitBreaker = getN8nCircuitBreaker();
    
    try {
      await circuitBreaker.call(eventName, payload);
    } catch (error: any) {
      // CircuitBreaker handles all error cases internally (retries, DLQ storage)
      // This catch is a safety net for unexpected errors
      logger.error(`[n8n] Unexpected error sending event ${eventName}: ${error.message}`);
    }
  }
}
