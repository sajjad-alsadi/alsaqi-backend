// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Unit Tests - Enhanced Health Check Endpoint (Task 17.1)
 *
 * Tests the comprehensive health check that verifies:
 * - Database connectivity
 * - Filesystem (uploads dir writable + ≥100MB free)
 * - Memory (< 90% heap)
 * - WebSocket server (accepting connections)
 * - Cron status (last run within expected interval)
 *
 * Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7
 */

// Mock the database module
vi.mock('../../db/index', () => ({
  db: {
    isExternal: false,
    client: { dataDir: '/tmp/test' },
    prepare: vi.fn(() => ({
      get: vi.fn().mockResolvedValue({ health_check: 1 }),
      all: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ changes: 0 }),
    })),
  },
}));

// Mock fs.promises for filesystem checks
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        access: vi.fn().mockResolvedValue(undefined),
        statfs: vi.fn().mockResolvedValue({
          bfree: 500000, // ~500MB free with 1024 bsize
          bsize: 1024,
        }),
      },
      constants: actual.constants,
    },
    promises: {
      ...actual.promises,
      access: vi.fn().mockResolvedValue(undefined),
      statfs: vi.fn().mockResolvedValue({
        bfree: 500000,
        bsize: 1024,
      }),
    },
    constants: actual.constants,
  };
});

import { createHealthRouter, updateCronLastRun, getCronLastRun } from '../health';

function createTestApp(withWss = true) {
  const app = express();
  app.use(express.json());

  if (withWss) {
    // Mock WebSocket server
    (app as any).wss = {
      clients: new Set([
        { readyState: 1, authenticated: true, userId: 'user-1' },
        { readyState: 1, authenticated: false, userId: 'user-2' },
      ]),
    };
  }

  app.use('/', createHealthRouter());
  return app;
}

describe('Enhanced Health Check Endpoint (Task 17.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Requirement 15.1: Subsystem checks', () => {
    it('should check all five subsystems', async () => {
      // Mark cron as recently run
      updateCronLastRun();

      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.checks).toBeDefined();
      expect(res.body.checks.database).toBeDefined();
      expect(res.body.checks.filesystem).toBeDefined();
      expect(res.body.checks.memory).toBeDefined();
      expect(res.body.checks.websocket).toBeDefined();
      expect(res.body.checks.cron).toBeDefined();
    });

    it('should include latency for each subsystem', async () => {
      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.body.checks.database.latency).toBeTypeOf('number');
      expect(res.body.checks.filesystem.latency).toBeTypeOf('number');
      expect(res.body.checks.memory.latency).toBeTypeOf('number');
      expect(res.body.checks.websocket.latency).toBeTypeOf('number');
      expect(res.body.checks.cron.latency).toBeTypeOf('number');
    });
  });

  describe('Requirement 15.2: Healthy status when all pass', () => {
    it('should return "healthy" with 200 when all checks pass', async () => {
      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.checks.database.status).toBe('ok');
      expect(res.body.checks.memory.status).toBe('ok');
      expect(res.body.checks.websocket.status).toBe('ok');
    });
  });

  describe('Requirement 15.3: Unhealthy when DB fails', () => {
    it('should return "unhealthy" with 503 when database check fails', async () => {
      const { db } = await import('../../db/index');
      (db.prepare as any).mockReturnValueOnce({
        get: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });

      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.checks.database.status).toBe('fail');
    });
  });

  describe('Requirement 15.4: Degraded when non-DB fails', () => {
    it('should return "degraded" with 200 when WebSocket is not available', async () => {
      updateCronLastRun();
      const app = createTestApp(false); // No WSS
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.checks.websocket.status).toBe('fail');
    });
  });

  describe('Requirement 15.5: Independent 2-second timeout per check', () => {
    it('should timeout a slow database check without blocking others', async () => {
      const { db } = await import('../../db/index');
      // Make DB check hang for longer than 2s
      (db.prepare as any).mockReturnValueOnce({
        get: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 5000))),
      });

      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      // DB should timeout
      expect(res.body.checks.database.status).toBe('timeout');
      // Other checks should still complete
      expect(res.body.checks.memory.status).toBe('ok');
      expect(res.body.checks.websocket.status).toBe('ok');
    }, 10000);
  });

  describe('Requirement 15.6: Latency measurements', () => {
    it('should report latency even for failed checks', async () => {
      const { db } = await import('../../db/index');
      (db.prepare as any).mockReturnValueOnce({
        get: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.body.checks.database.latency).toBeGreaterThanOrEqual(0);
      expect(res.body.checks.database.status).toBe('fail');
    });
  });

  describe('Requirement 15.7: Response within 3 seconds', () => {
    it('should include uptime and version in response', async () => {
      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.body.uptime).toBeTypeOf('number');
      expect(res.body.version).toBe('1.0');
    });

    it('should return HTTP 200 for healthy', async () => {
      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
    });

    it('should return HTTP 200 for degraded', async () => {
      updateCronLastRun();
      const app = createTestApp(false);
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
    });

    it('should return HTTP 503 for unhealthy', async () => {
      const { db } = await import('../../db/index');
      (db.prepare as any).mockReturnValueOnce({
        get: vi.fn().mockRejectedValue(new Error('DB down')),
      });

      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
    });
  });

  describe('Cron status tracking', () => {
    it('should track cron last run timestamp', () => {
      updateCronLastRun();
      const lastRun = getCronLastRun();
      expect(lastRun).toBeDefined();
      expect(new Date(lastRun!).toISOString()).toBe(lastRun);
    });

    it('should report cron as ok when recently run', async () => {
      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.body.checks.cron.status).toBe('ok');
    });
  });

  describe('WebSocket check', () => {
    it('should report connection count in details', async () => {
      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.body.checks.websocket.status).toBe('ok');
      expect(res.body.checks.websocket.details.connections).toBe(2);
    });
  });

  describe('Memory check', () => {
    it('should report heap usage details', async () => {
      updateCronLastRun();
      const app = createTestApp();
      const res = await request(app).get('/health');

      expect(res.body.checks.memory.status).toBe('ok');
      expect(res.body.checks.memory.details.heapUsedMB).toBeTypeOf('number');
      expect(res.body.checks.memory.details.heapTotalMB).toBeTypeOf('number');
      expect(res.body.checks.memory.details.usagePercent).toBeTypeOf('number');
    });
  });
});
