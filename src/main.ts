/**
 * @alsaqi/api - Standalone Entry Point
 *
 * Reads configuration from environment variables and starts the API server.
 * This file is the main entry point when running the API package independently.
 */

import 'dotenv/config';
import type { WebSocketServer } from 'ws';
import { validateEnvironmentOnStartup } from './config/envValidator.js';
import { waitForDependencies } from './startup/dependencyCheck.js';
import { getShutdownDrainTimeoutMs } from './config/environmentConfig.js';
import { createGracefulShutdown } from './server/gracefulShutdown.js';
import { createApiServer } from './index.js';
import type { ApiServerConfig } from './index.js';

// ─── Environment Validation (must run before any other initialization) ────────
// Validates all required env vars, exits with FATAL in production if invalid.
const envValidation = validateEnvironmentOnStartup();
if (!envValidation.isValid && process.env.NODE_ENV === 'production') {
  // Process will exit via validateEnvironmentOnStartup, but we stop execution here
  // to prevent any further initialization from running.
  // The exit is handled inside validateEnvironmentOnStartup with a guaranteed <5s exit.
  await new Promise(() => {}); // Block forever; process.exit() will terminate us
}

// ─── Environment Variable Parsing ────────────────────────────────────────────

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function parseNodeEnv(value: string): 'development' | 'production' | 'test' {
  if (value === 'production' || value === 'test') {
    return value;
  }
  return 'development';
}

function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function normalizeKey(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

// ─── Build Config ────────────────────────────────────────────────────────────

const nodeEnv = parseNodeEnv(getOptionalEnv('NODE_ENV', 'development'));

// In development, allow fallback values for easier local setup
const isDev = nodeEnv === 'development';

const config: ApiServerConfig = {
  port: parseInt(getOptionalEnv('PORT', '3000'), 10),
  corsOrigins: parseCorsOrigins(
    getOptionalEnv('CORS_ORIGIN', isDev ? 'http://localhost:5173' : '')
  ),
  jwtSecret: isDev
    ? getOptionalEnv('JWT_SECRET', 'alsaqi-dev-secret-key-123')
    : getRequiredEnv('JWT_SECRET'),
  jwtPrivateKey: normalizeKey(process.env.JWT_PRIVATE_KEY),
  jwtPublicKey: normalizeKey(process.env.JWT_PUBLIC_KEY),
  databaseUrl: getOptionalEnv('DATABASE_URL', ''),
  uploadDir: getOptionalEnv('UPLOAD_DIR', './uploads'),
  nodeEnv,
};

// ─── Dependency Readiness Check (Production Only) ────────────────────────────
// Verify PostgreSQL and Redis are ready before accepting HTTP requests.
// Wait up to 30 seconds with 5-second retry intervals. Exit(1) if not ready.
// Requirements: 7.3, 7.4

if (nodeEnv === 'production') {
  const databaseUrl = (config.databaseUrl || '').trim();
  const redisUrl = (process.env.REDIS_URL || '').trim();

  // Treat an unset or whitespace-only DATABASE_URL / REDIS_URL as a failed
  // dependency rather than skipping the check (Req 1.6).
  const missing: string[] = [];
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!redisUrl) missing.push('REDIS_URL');

  if (missing.length > 0) {
    console.error(
      `[Startup] FATAL: Required production dependencies are not configured: ` +
      `${missing.join(', ')} is unset or empty. Exiting with code 1.`
    );
    process.exit(1);
  }

  await waitForDependencies({
    databaseUrl,
    redisUrl,
    timeoutMs: 30_000,
    retryIntervalMs: 5_000,
  });
}

// ─── Start Server ────────────────────────────────────────────────────────────

const server = createApiServer(config);

server
  .start()
  .then(() => {
    console.log(`[alsaqi/api] Server running on port ${config.port}`);
    console.log(`[alsaqi/api] Environment: ${config.nodeEnv}`);
  })
  .catch((err) => {
    console.error('[alsaqi/api] Failed to start server:', err.message);
    process.exit(1);
  });

// ─── Graceful Shutdown Signals ───────────────────────────────────────────────
// On a shutdown signal (or an uncaught exception) the server stops accepting new
// connections, drains in-flight requests within the configured drain timeout
// (SHUTDOWN_DRAIN_TIMEOUT_MS, 1000..120000 ms, default 30000), then exits 0 if it
// drained in time or non-zero if the timeout elapsed (Requirement 23).

const httpServer = server.getHttpServer();
const gracefulShutdown = createGracefulShutdown(httpServer, {
  drainTimeoutMs: getShutdownDrainTimeoutMs(),
});

// Close any active WebSocket clients so they do not hold the drain open until the
// timeout. The HTTP drain itself is owned by createGracefulShutdown.
function closeWebSocketClients(): void {
  const wss = (server.getApp() as unknown as { wss?: WebSocketServer }).wss;
  if (!wss) {
    return;
  }
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }
}

function handleShutdownSignal(signal: string): void {
  closeWebSocketClients();
  void gracefulShutdown(signal);
}

process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

// 23.5 / 23.6: An uncaught exception drains in-flight requests via the same
// drain-then-exit path instead of exiting immediately.
process.on('uncaughtException', (err) => {
  console.error('[alsaqi/api] UNCAUGHT EXCEPTION:', err);
  handleShutdownSignal('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('[alsaqi/api] UNHANDLED REJECTION:', reason);
});
