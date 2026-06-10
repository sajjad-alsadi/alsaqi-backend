/**
 * Redis Connection Manager with Graceful Degradation
 *
 * Provides a singleton Redis client using ioredis with:
 * - Connection to REDIS_URL from environment variables
 * - 5-second connection timeout
 * - Auto-reconnect every 5 seconds, max 3 attempts
 * - Graceful degradation: continues without cache when Redis is down, logs warn
 * - Refuses startup in production if REDIS_URL is undefined
 *
 * Validates: Requirements 2.1, 2.4, 2.6
 */

import Redis, { type Redis as RedisClient } from 'ioredis';
import logger from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RedisManagerOptions {
  /** Redis connection URL (defaults to process.env.REDIS_URL) */
  url?: string;
  /** Connection timeout in milliseconds (default: 5000) */
  connectTimeout?: number;
  /** Reconnect interval in milliseconds (default: 5000) */
  reconnectInterval?: number;
  /** Maximum reconnect attempts (default: 3) */
  maxReconnectAttempts?: number;
}

export type RedisConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'degraded';

// ─── Redis Manager ───────────────────────────────────────────────────────────

export class RedisManager {
  private client: RedisClient | null = null;
  private _status: RedisConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  private readonly connectTimeout: number;
  private readonly reconnectInterval: number;
  private readonly maxReconnectAttempts: number;

  constructor(options: RedisManagerOptions = {}) {
    this.url = options.url || process.env.REDIS_URL || '';
    this.connectTimeout = options.connectTimeout ?? 5000;
    this.reconnectInterval = options.reconnectInterval ?? 5000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
  }

  /** Current connection status */
  get status(): RedisConnectionStatus {
    return this._status;
  }

  /** Whether the Redis connection is available for operations */
  get isAvailable(): boolean {
    return this._status === 'connected' && this.client !== null;
  }

  /**
   * Initialize the Redis connection.
   * In production, refuses to start if REDIS_URL is not defined.
   * Returns true if connection is established within the timeout.
   */
  async connect(): Promise<boolean> {
    const isProduction = process.env.NODE_ENV === 'production';

    // Requirement 2.6: Refuse startup in production if REDIS_URL is not defined
    if (!this.url) {
      if (isProduction) {
        logger.error(
          '[Redis] FATAL: REDIS_URL is not defined. Cannot start in production without Redis. ' +
          'Please set the REDIS_URL environment variable.'
        );
        process.exit(1);
      }
      logger.warn('[Redis] REDIS_URL is not defined. Running without Redis cache.');
      this._status = 'degraded';
      return false;
    }

    this._status = 'connecting';

    try {
      await this.createConnection();
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`[Redis] Initial connection failed: ${errorMessage}. Operating in degraded mode.`);
      this._status = 'degraded';
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Creates the Redis connection with configured timeout and retry strategy.
   */
  private createConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Clear any existing connection
      if (this.client) {
        this.client.disconnect();
        this.client = null;
      }

      this.client = new (Redis as any)(this.url, {
        connectTimeout: this.connectTimeout,
        maxRetriesPerRequest: null, // BullMQ compatibility
        lazyConnect: true,
        retryStrategy: () => {
          // Disable ioredis built-in retry; we handle reconnection ourselves
          return null;
        },
      });

      const connectionTimeout = setTimeout(() => {
        if (this._status === 'connecting') {
          this.client?.disconnect();
          reject(new Error(`Redis connection timed out after ${this.connectTimeout}ms`));
        }
      }, this.connectTimeout);

      this.client.on('connect', () => {
        clearTimeout(connectionTimeout);
        this._status = 'connected';
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
        logger.info('[Redis] Connection established successfully.');
        resolve();
      });

      this.client.on('error', (err) => {
        // Only log if not already handled
        if (this._status === 'connected') {
          logger.warn(`[Redis] Connection error: ${err.message}. Entering degraded mode.`);
          this._status = 'degraded';
          this.scheduleReconnect();
        }
      });

      this.client.on('close', () => {
        if (this._status === 'connected') {
          logger.warn('[Redis] Connection closed unexpectedly. Entering degraded mode.');
          this._status = 'degraded';
          this.scheduleReconnect();
        }
      });

      // Attempt the connection
      this.client.connect().catch((err) => {
        clearTimeout(connectionTimeout);
        reject(err);
      });
    });
  }

  /**
   * Schedules a reconnection attempt.
   * Requirement 2.4: attempt reconnection every 5 seconds up to 3 attempts.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // Already scheduled
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(
        `[Redis] Max reconnection attempts (${this.maxReconnectAttempts}) exhausted. ` +
        'Continuing without cache. Manual intervention may be required.'
      );
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;

      logger.info(
        `[Redis] Attempting reconnection (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
      );

      try {
        await this.createConnection();
        logger.info('[Redis] Reconnection successful.');
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.warn(`[Redis] Reconnection attempt ${this.reconnectAttempts} failed: ${errorMessage}`);
        this._status = 'degraded';
        this.scheduleReconnect();
      }
    }, this.reconnectInterval);
  }

  /** Clears the reconnection timer */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─── Cache Operations (with graceful degradation) ────────────────────────

  /**
   * Get a value from Redis cache.
   * Returns null if Redis is unavailable (graceful degradation).
   */
  async get(key: string): Promise<string | null> {
    if (!this.isAvailable) {
      return null;
    }

    try {
      return await this.client!.get(key);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`[Redis] GET failed for key "${key}": ${errorMessage}`);
      return null;
    }
  }

  /**
   * Set a value in Redis cache with optional TTL.
   * No-op if Redis is unavailable (graceful degradation).
   *
   * @param key - Cache key
   * @param value - Value to store
   * @param ttlSeconds - Time to live in seconds (optional)
   * @returns true if set successfully, false otherwise
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (!this.isAvailable) {
      return false;
    }

    try {
      if (ttlSeconds !== undefined && ttlSeconds > 0) {
        await this.client!.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client!.set(key, value);
      }
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`[Redis] SET failed for key "${key}": ${errorMessage}`);
      return false;
    }
  }

  /**
   * Delete a key from Redis cache.
   * No-op if Redis is unavailable (graceful degradation).
   *
   * @param key - Cache key to delete
   * @returns true if deleted successfully, false otherwise
   */
  async del(key: string): Promise<boolean> {
    if (!this.isAvailable) {
      return false;
    }

    try {
      await this.client!.del(key);
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`[Redis] DEL failed for key "${key}": ${errorMessage}`);
      return false;
    }
  }

  /**
   * Get the underlying ioredis client instance.
   * Useful for advanced operations or BullMQ integration.
   * Returns null if Redis is not connected.
   */
  getClient(): RedisClient | null {
    return this.isAvailable ? this.client : null;
  }

  /**
   * Gracefully disconnect from Redis.
   */
  async disconnect(): Promise<void> {
    this.clearReconnectTimer();

    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
      this.client = null;
    }

    this._status = 'disconnected';
    logger.info('[Redis] Disconnected.');
  }

  /**
   * Ping Redis to check connectivity.
   * Returns true if Redis responds with PONG.
   */
  async ping(): Promise<boolean> {
    if (!this.isAvailable) {
      return false;
    }

    try {
      const response = await this.client!.ping();
      return response === 'PONG';
    } catch {
      return false;
    }
  }
}

// ─── Singleton Instance ──────────────────────────────────────────────────────

/** Singleton Redis manager instance for application-wide use */
export const redisManager = new RedisManager();

export default redisManager;
