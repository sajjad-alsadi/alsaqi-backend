import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/index';
import { HealthStatus, SubsystemCheck } from '../types/api';

/**
 * Cron status tracker.
 * Updated by the cron module after each successful run.
 * The expected interval is 24 hours (daily cron).
 */
let cronLastRunTimestamp: string | null = null;
const CRON_EXPECTED_INTERVAL_MS = 25 * 60 * 60 * 1000; // 25 hours (24h + 1h grace)

export function updateCronLastRun(): void {
  cronLastRunTimestamp = new Date().toISOString();
}

export function getCronLastRun(): string | null {
  return cronLastRunTimestamp;
}

/**
 * Individual check timeout (2 seconds).
 */
const CHECK_TIMEOUT_MS = 2000;

/**
 * Overall response timeout (3 seconds).
 */
const OVERALL_TIMEOUT_MS = 3000;

/**
 * Wraps a check function with an independent 2-second timeout.
 * Returns the SubsystemCheck result with latency measured regardless of outcome.
 */
async function withTimeout(
  checkFn: () => Promise<SubsystemCheck>
): Promise<SubsystemCheck> {
  const start = Date.now();

  return new Promise<SubsystemCheck>((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        status: 'timeout',
        latency: Date.now() - start,
        details: { reason: 'Check timed out after 2000ms' },
      });
    }, CHECK_TIMEOUT_MS);

    checkFn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        resolve({
          status: 'fail',
          latency: Date.now() - start,
          details: { reason: err?.message || 'Unknown error' },
        });
      });
  });
}

/**
 * Check database connectivity by executing a simple query.
 */
async function checkDatabase(): Promise<SubsystemCheck> {
  const start = Date.now();
  await db.prepare('SELECT 1 AS health_check').get();
  return {
    status: 'ok',
    latency: Date.now() - start,
    details: {
      type: db.isExternal ? 'PostgreSQL' : 'PGlite',
    },
  };
}

/**
 * Check filesystem: uploads directory is writable and has at least 100MB free space.
 * Uses Node.js fs.statfs (available in Node 18.15+) for disk space.
 */
async function checkFilesystem(): Promise<SubsystemCheck> {
  const start = Date.now();
  const uploadDir = path.join(process.cwd(), 'uploads');

  // Check directory exists and is writable
  await fs.promises.access(uploadDir, fs.constants.W_OK);

  // Check free space (≥100MB)
  let freeSpaceMB: number | null = null;
  try {
    const stats = await fs.promises.statfs(uploadDir);
    const freeBytes = stats.bfree * stats.bsize;
    freeSpaceMB = Math.round(freeBytes / (1024 * 1024));

    if (freeSpaceMB < 100) {
      return {
        status: 'fail',
        latency: Date.now() - start,
        details: { freeSpaceMB, reason: 'Less than 100MB free space' },
      };
    }
  } catch {
    // statfs may not be available on all platforms; if writable, consider it ok
    freeSpaceMB = null;
  }

  return {
    status: 'ok',
    latency: Date.now() - start,
    details: { writable: true, ...(freeSpaceMB !== null && { freeSpaceMB }) },
  };
}

/**
 * Check memory usage: heap used should be less than 90% of heap total.
 */
async function checkMemory(): Promise<SubsystemCheck> {
  const start = Date.now();
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / (1024 * 1024));
  const heapTotalMB = Math.round(mem.heapTotal / (1024 * 1024));
  const usagePercent = (mem.heapUsed / mem.heapTotal) * 100;

  if (usagePercent >= 90) {
    return {
      status: 'fail',
      latency: Date.now() - start,
      details: {
        heapUsedMB,
        heapTotalMB,
        usagePercent: Math.round(usagePercent),
        reason: 'Heap usage exceeds 90% threshold',
      },
    };
  }

  return {
    status: 'ok',
    latency: Date.now() - start,
    details: { heapUsedMB, heapTotalMB, usagePercent: Math.round(usagePercent) },
  };
}

/**
 * Check WebSocket server: verify it's accepting connections.
 * Accesses the wss instance from the Express app.
 */
async function checkWebSocket(req: Request): Promise<SubsystemCheck> {
  const start = Date.now();
  const wss = (req.app as any).wss;

  if (!wss) {
    return {
      status: 'fail',
      latency: Date.now() - start,
      details: { reason: 'WebSocket server not initialized' },
    };
  }

  // Check that the WSS is in a state that accepts connections
  // WebSocketServer doesn't have a "closed" property, but we can check
  // if it has the clients Set (indicating it's operational)
  const clientCount = wss.clients ? wss.clients.size : 0;

  return {
    status: 'ok',
    latency: Date.now() - start,
    details: { connections: clientCount },
  };
}

/**
 * Check cron status: verify the last scheduled execution completed within the expected interval.
 */
async function checkCron(): Promise<SubsystemCheck> {
  const start = Date.now();
  const lastRun = getCronLastRun();

  if (!lastRun) {
    // If cron has never run, it might be a fresh start - check if server just started
    const uptimeSeconds = process.uptime();
    // If server has been up for less than the expected interval, it's ok (cron hasn't had a chance to run yet)
    if (uptimeSeconds < CRON_EXPECTED_INTERVAL_MS / 1000) {
      return {
        status: 'ok',
        latency: Date.now() - start,
        details: { lastRun: null, note: 'Server recently started, cron not yet due' },
      };
    }

    return {
      status: 'fail',
      latency: Date.now() - start,
      details: { lastRun: null, reason: 'Cron has never run and server uptime exceeds expected interval' },
    };
  }

  const lastRunTime = new Date(lastRun).getTime();
  const elapsed = Date.now() - lastRunTime;

  if (elapsed > CRON_EXPECTED_INTERVAL_MS) {
    return {
      status: 'fail',
      latency: Date.now() - start,
      details: {
        lastRun,
        elapsedMs: elapsed,
        reason: 'Last cron run exceeds expected interval',
      },
    };
  }

  return {
    status: 'ok',
    latency: Date.now() - start,
    details: { lastRun },
  };
}

/**
 * Derive overall health status from individual check results.
 * - "unhealthy" (503) if database fails
 * - "degraded" (200) if any non-database check fails
 * - "healthy" (200) if all pass
 */
function deriveOverallStatus(checks: HealthStatus['checks']): HealthStatus['status'] {
  if (checks.database.status !== 'ok') {
    return 'unhealthy';
  }

  const nonDbChecks = [checks.filesystem, checks.memory, checks.websocket, checks.cron];
  const anyNonDbFailed = nonDbChecks.some((c) => c.status !== 'ok');

  if (anyNonDbFailed) {
    return 'degraded';
  }

  return 'healthy';
}

/**
 * Creates the enhanced health check router.
 */
export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', async (req: Request, res: Response) => {
    // Overall timeout: respond within 3 seconds regardless
    const overallStart = Date.now();

    const overallTimeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), OVERALL_TIMEOUT_MS);
    });

    const checksPromise = (async () => {
      // Run all checks in parallel with independent timeouts
      const [database, filesystem, memory, websocket, cron] = await Promise.all([
        withTimeout(checkDatabase),
        withTimeout(checkFilesystem),
        withTimeout(checkMemory),
        withTimeout(() => checkWebSocket(req)),
        withTimeout(checkCron),
      ]);

      return { database, filesystem, memory, websocket, cron };
    })();

    // Race between checks completing and overall timeout
    const checks = await Promise.race([checksPromise, overallTimeout]);

    // If overall timeout hit, return partial results
    const finalChecks: HealthStatus['checks'] = checks || {
      database: { status: 'timeout', latency: OVERALL_TIMEOUT_MS, details: { reason: 'Overall timeout' } },
      filesystem: { status: 'timeout', latency: OVERALL_TIMEOUT_MS, details: { reason: 'Overall timeout' } },
      memory: { status: 'timeout', latency: OVERALL_TIMEOUT_MS, details: { reason: 'Overall timeout' } },
      websocket: { status: 'timeout', latency: OVERALL_TIMEOUT_MS, details: { reason: 'Overall timeout' } },
      cron: { status: 'timeout', latency: OVERALL_TIMEOUT_MS, details: { reason: 'Overall timeout' } },
    };

    const status = deriveOverallStatus(finalChecks);
    const httpStatus = status === 'unhealthy' ? 503 : 200;

    const response: HealthStatus = {
      status,
      checks: finalChecks,
      uptime: process.uptime(),
      version: '1.0',
    };

    res.status(httpStatus).json(response);
  });

  return router;
}
