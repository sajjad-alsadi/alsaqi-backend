import { createPool, type Pool, type Options } from 'generic-pool';
import puppeteer, { type Browser } from 'puppeteer';
import logger from '../utils/logger.js';

/**
 * Maximum number of concurrent Puppeteer browser instances.
 * Requirement 10.1
 */
const MAX_POOL_SIZE = 3;

/**
 * Number of pages a browser instance may render before being recycled.
 * Requirement 10.2
 */
const MAX_PAGES_PER_INSTANCE = 50;

/**
 * Maximum time (ms) a request will wait in queue for an available browser.
 * Requirement 10.6
 */
const ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * Maximum time (ms) allowed for dispose() to close all browsers.
 * Requirement 10.4
 */
const DISPOSE_TIMEOUT_MS = 10_000;

/**
 * Tracks per-browser metadata (render count).
 */
interface BrowserMeta {
  renderCount: number;
}

/**
 * BrowserPool — Manages a pool of Puppeteer browser instances.
 *
 * Features:
 * - Max 3 concurrent instances (Req 10.1)
 * - Recycles instances after 50 page renders (Req 10.2)
 * - Lazy initialization on first acquire (Req 10.3)
 * - dispose() closes all browsers within 10s (Req 10.4)
 * - Queues requests when all busy, timeout after 30s (Req 10.6)
 * - Handles crashed/unresponsive instances (Req 10.7)
 */
export class BrowserPool {
  private pool: Pool<Browser> | null = null;
  private meta: Map<Browser, BrowserMeta> = new Map();
  private disposed = false;

  /**
   * Lazily initializes the pool on first call.
   * Requirement 10.3: first request triggers pool creation.
   */
  private ensurePool(): Pool<Browser> {
    if (this.disposed) {
      throw new Error('BrowserPool has been disposed');
    }

    if (!this.pool) {
      const factory = {
        create: async (): Promise<Browser> => {
          logger.info('[BrowserPool] Creating new browser instance');
          const browser = await puppeteer.launch({
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
            ],
          });

          // Handle unexpected disconnection (Req 10.7)
          browser.on('disconnected', () => {
            logger.warn('[BrowserPool] Browser disconnected unexpectedly');
            this.meta.delete(browser);
            // Attempt to destroy from pool (best-effort)
            if (this.pool) {
              this.pool.destroy(browser).catch(() => {
                // Already disconnected, ignore
              });
            }
          });

          this.meta.set(browser, { renderCount: 0 });
          return browser;
        },

        destroy: async (browser: Browser): Promise<void> => {
          logger.info('[BrowserPool] Destroying browser instance');
          this.meta.delete(browser);
          try {
            await browser.close();
          } catch (err) {
            // Browser may already be closed/crashed
            logger.warn('[BrowserPool] Error closing browser (may already be closed):', err);
          }
        },

        validate: async (browser: Browser): Promise<boolean> => {
          try {
            // Check if browser is still connected
            if (!browser.connected) {
              logger.warn('[BrowserPool] Browser is not connected, invalid');
              return false;
            }

            // Check render count — recycle if exceeded (Req 10.2)
            const meta = this.meta.get(browser);
            if (meta && meta.renderCount >= MAX_PAGES_PER_INSTANCE) {
              logger.info(
                `[BrowserPool] Browser exceeded ${MAX_PAGES_PER_INSTANCE} renders, recycling`
              );
              return false;
            }

            return true;
          } catch {
            return false;
          }
        },
      };

      const poolOptions: Options = {
        max: MAX_POOL_SIZE,
        min: 0, // Don't pre-warm — lazy init only (Req 10.3)
        acquireTimeoutMillis: ACQUIRE_TIMEOUT_MS, // Req 10.6
        testOnBorrow: true, // Validate before handing out
        autostart: false, // Don't create instances until needed
      };

      this.pool = createPool(factory, poolOptions);

      // Log pool errors
      this.pool.on('factoryCreateError', (err) => {
        logger.error('[BrowserPool] Factory create error:', err);
      });

      this.pool.on('factoryDestroyError', (err) => {
        logger.error('[BrowserPool] Factory destroy error:', err);
      });
    }

    return this.pool;
  }

  /**
   * Acquires a browser instance from the pool.
   *
   * If all instances are busy, the request is queued and will timeout
   * after 30 seconds (Req 10.6).
   *
   * Returns: a browser instance ready for use.
   * Throws: Error if pool is disposed or acquire times out.
   */
  async acquire(): Promise<Browser> {
    const pool = this.ensurePool();

    try {
      const browser = await pool.acquire();

      // Double-check connectivity after acquiring (Req 10.7)
      if (!browser.connected) {
        logger.warn('[BrowserPool] Acquired browser is not connected, destroying and retrying');
        await pool.destroy(browser);
        // Retry once — pool will create a new instance
        return pool.acquire();
      }

      return browser;
    } catch (err: any) {
      if (err.message?.includes('timeout') || err.name === 'TimeoutError') {
        throw new Error(
          `BrowserPool acquire timeout: all ${MAX_POOL_SIZE} instances are busy and ` +
            `the request waited more than ${ACQUIRE_TIMEOUT_MS / 1000} seconds`
        );
      }
      throw err;
    }
  }

  /**
   * Releases a browser instance back to the pool.
   *
   * Increments the render count. If the instance has exceeded
   * MAX_PAGES_PER_INSTANCE, it will be recycled on next validation (Req 10.2).
   */
  async release(browser: Browser): Promise<void> {
    if (!this.pool) return;

    const meta = this.meta.get(browser);
    if (meta) {
      meta.renderCount++;
    }

    // If the browser has disconnected while we held it, destroy instead of release
    if (!browser.connected) {
      logger.warn('[BrowserPool] Releasing disconnected browser — destroying instead');
      this.meta.delete(browser);
      await this.pool.destroy(browser).catch(() => {});
      return;
    }

    await this.pool.release(browser);
  }

  /**
   * Closes all browser instances and drains the pool within 10 seconds.
   * Requirement 10.4
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (!this.pool) {
      this.meta.clear();
      return;
    }

    logger.info('[BrowserPool] Disposing — closing all browser instances');

    const pool = this.pool;
    this.pool = null;

    // Race: drain the pool vs. hard timeout
    await Promise.race([
      pool.drain().then(() => pool.clear()),
      new Promise<void>((resolve) => {
        setTimeout(async () => {
          logger.warn('[BrowserPool] Dispose timeout reached, force-closing remaining browsers');
          // Force-close any remaining browsers
          for (const [browser] of this.meta) {
            try {
              await browser.close();
            } catch {
              // Ignore errors during force close
            }
          }
          this.meta.clear();
          resolve();
        }, DISPOSE_TIMEOUT_MS);
      }),
    ]);

    this.meta.clear();
    logger.info('[BrowserPool] Disposed successfully');
  }

  /**
   * Returns the current render count for a browser instance.
   * Useful for monitoring/debugging.
   */
  getRenderCount(browser: Browser): number {
    return this.meta.get(browser)?.renderCount ?? 0;
  }

  /**
   * Returns pool statistics (for monitoring).
   */
  get stats() {
    if (!this.pool) {
      return { size: 0, available: 0, borrowed: 0, pending: 0 };
    }
    return {
      size: this.pool.size,
      available: this.pool.available,
      borrowed: this.pool.borrowed,
      pending: this.pool.pending,
    };
  }

  /**
   * Whether the pool has been disposed.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * Singleton browser pool instance.
 * Shared across the application for resource efficiency.
 */
export const browserPool = new BrowserPool();
