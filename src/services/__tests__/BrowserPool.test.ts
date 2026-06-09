// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock puppeteer
let mockBrowserConnectedValue = true;

function createMockBrowser() {
  const eventHandlers: Record<string, Function[]> = {};
  const browser = {
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: Function) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
    }),
    get connected() {
      return mockBrowserConnectedValue;
    },
    _emit(event: string) {
      (eventHandlers[event] || []).forEach((h) => h());
    },
  };
  return browser;
}

vi.mock('puppeteer', () => ({
  default: {
    launch: vi.fn().mockImplementation(async () => createMockBrowser()),
  },
}));

import { BrowserPool } from '../BrowserPool.js';

describe('BrowserPool', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowserConnectedValue = true;
    pool = new BrowserPool();
  });

  afterEach(async () => {
    try {
      if (!pool.isDisposed) {
        await pool.dispose();
      }
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe('lazy initialization (Req 10.3)', () => {
    it('should not create browser instances until first acquire', () => {
      expect(pool.stats.size).toBe(0);
      expect(pool.stats.borrowed).toBe(0);
    });

    it('should create the pool on first acquire', async () => {
      const browser = await pool.acquire();
      expect(browser).toBeDefined();
      expect(pool.stats.borrowed).toBe(1);
      await pool.release(browser);
    });
  });

  describe('acquire and release', () => {
    it('should acquire a browser instance', async () => {
      const browser = await pool.acquire();
      expect(browser).toBeDefined();
      expect(browser.connected).toBe(true);
      await pool.release(browser);
    });

    it('should increment render count on release', async () => {
      const browser = await pool.acquire();
      expect(pool.getRenderCount(browser)).toBe(0);
      await pool.release(browser);
      expect(pool.getRenderCount(browser)).toBe(1);
    });

    it('should throw when acquiring from a disposed pool', async () => {
      await pool.dispose();
      await expect(pool.acquire()).rejects.toThrow('BrowserPool has been disposed');
    });
  });

  describe('pool size limit (Req 10.1)', () => {
    it('should have max pool size of 3', async () => {
      const browsers = [];
      for (let i = 0; i < 3; i++) {
        browsers.push(await pool.acquire());
      }
      expect(pool.stats.borrowed).toBe(3);

      for (const b of browsers) {
        await pool.release(b);
      }
    });
  });

  describe('recycling after 50 renders (Req 10.2)', () => {
    it('should track render count across acquire/release cycles', async () => {
      let browser = await pool.acquire();
      await pool.release(browser);
      expect(pool.getRenderCount(browser)).toBe(1);

      browser = await pool.acquire();
      await pool.release(browser);
      expect(pool.getRenderCount(browser)).toBe(2);

      browser = await pool.acquire();
      await pool.release(browser);
      expect(pool.getRenderCount(browser)).toBe(3);
    });
  });

  describe('crashed instance handling (Req 10.7)', () => {
    it('should destroy disconnected browser on release', async () => {
      const browser = await pool.acquire();
      mockBrowserConnectedValue = false;
      await pool.release(browser);
      expect(pool.stats.borrowed).toBe(0);
      // Restore so afterEach dispose works
      mockBrowserConnectedValue = true;
    });
  });

  describe('dispose (Req 10.4)', () => {
    it('should mark as disposed after calling dispose', async () => {
      const browser = await pool.acquire();
      await pool.release(browser);
      await pool.dispose();
      expect(pool.isDisposed).toBe(true);
    });

    it('should be idempotent — second dispose is a no-op', async () => {
      await pool.dispose();
      await pool.dispose();
      expect(pool.isDisposed).toBe(true);
    });

    it('should complete within a reasonable time', async () => {
      const browser = await pool.acquire();
      await pool.release(browser);
      const start = Date.now();
      await pool.dispose();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe('stats', () => {
    it('should return correct stats when pool not initialized', () => {
      const freshPool = new BrowserPool();
      expect(freshPool.stats).toEqual({
        size: 0,
        available: 0,
        borrowed: 0,
        pending: 0,
      });
    });

    it('should report borrowed count correctly', async () => {
      const b1 = await pool.acquire();
      expect(pool.stats.borrowed).toBe(1);
      const b2 = await pool.acquire();
      expect(pool.stats.borrowed).toBe(2);
      await pool.release(b1);
      expect(pool.stats.borrowed).toBe(1);
      await pool.release(b2);
      expect(pool.stats.borrowed).toBe(0);
    });
  });
});
