/**
 * Dependency Readiness Check
 *
 * Verifies that PostgreSQL and Redis are ready before the application
 * accepts HTTP requests. Retries every 5 seconds up to a maximum of
 * 30 seconds. Exits with code 1 if dependencies are not ready in time.
 *
 * Requirements: 7.3, 7.4
 */

import pg from 'pg';
import Redis from 'ioredis';

export interface DependencyCheckOptions {
  /** PostgreSQL connection string */
  databaseUrl: string;
  /** Redis connection URL */
  redisUrl: string;
  /** Maximum time to wait in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Interval between retries in milliseconds (default: 5000) */
  retryIntervalMs?: number;
}

export interface DependencyCheckResult {
  postgresReady: boolean;
  redisReady: boolean;
}

/**
 * Checks if PostgreSQL accepts TCP connections by executing a simple query.
 */
async function checkPostgres(databaseUrl: string): Promise<boolean> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 4000,
    max: 1,
  });

  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Checks if Redis responds to a PING command.
 */
async function checkRedis(redisUrl: string): Promise<boolean> {
  const redis = new Redis(redisUrl, {
    connectTimeout: 4000,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
    enableOfflineQueue: false,
  });

  try {
    await redis.connect();
    const response = await redis.ping();
    return response === 'PONG';
  } catch {
    return false;
  } finally {
    await redis.quit().catch(() => {
      redis.disconnect();
    });
  }
}

/**
 * Waits for PostgreSQL and Redis to become ready before allowing the
 * application to proceed. Retries every `retryIntervalMs` up to
 * `timeoutMs`. If either dependency is not ready within the timeout,
 * logs an error indicating which service is unavailable and exits
 * with code 1.
 */
export async function waitForDependencies(options: DependencyCheckOptions): Promise<DependencyCheckResult> {
  const {
    databaseUrl,
    redisUrl,
    timeoutMs = 30_000,
    retryIntervalMs = 5_000,
  } = options;

  const startTime = Date.now();
  let postgresReady = false;
  let redisReady = false;
  let attempt = 0;

  while (Date.now() - startTime < timeoutMs) {
    attempt++;
    console.log(`[Startup] Dependency readiness check attempt ${attempt}...`);

    // Check both dependencies in parallel
    const [pgResult, redisResult] = await Promise.all([
      postgresReady ? Promise.resolve(true) : checkPostgres(databaseUrl),
      redisReady ? Promise.resolve(true) : checkRedis(redisUrl),
    ]);

    if (pgResult && !postgresReady) {
      postgresReady = true;
      console.log('[Startup] PostgreSQL is ready.');
    }

    if (redisResult && !redisReady) {
      redisReady = true;
      console.log('[Startup] Redis is ready.');
    }

    if (postgresReady && redisReady) {
      console.log('[Startup] All dependencies are ready.');
      return { postgresReady, redisReady };
    }

    // Log which services are still pending
    const pending: string[] = [];
    if (!postgresReady) pending.push('PostgreSQL');
    if (!redisReady) pending.push('Redis');
    console.log(`[Startup] Waiting for: ${pending.join(', ')}. Retrying in ${retryIntervalMs / 1000}s...`);

    // Wait before next retry, but only if we haven't exceeded timeout
    const elapsed = Date.now() - startTime;
    const remaining = timeoutMs - elapsed;
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(retryIntervalMs, remaining)));
    }
  }

  // Timeout reached - log which services failed and exit
  const unavailable: string[] = [];
  if (!postgresReady) unavailable.push('PostgreSQL (TCP connection on port 5432)');
  if (!redisReady) unavailable.push('Redis (PING response)');

  console.error(
    `[Startup] FATAL: Dependencies not ready within ${timeoutMs / 1000} seconds. ` +
    `Unavailable services: ${unavailable.join(', ')}. Exiting with code 1.`
  );
  process.exit(1);
}
