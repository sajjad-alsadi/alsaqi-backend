/**
 * @alsaqi/api - Standalone Entry Point
 *
 * Reads configuration from environment variables and starts the API server.
 * This file is the main entry point when running the API package independently.
 */

import 'dotenv/config';
import { createApiServer } from './index.js';
import type { ApiServerConfig } from './index.js';

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

const shutdown = async (signal: string) => {
  console.log(`[alsaqi/api] ${signal} received, shutting down gracefully...`);
  await server.stop();
  console.log('[alsaqi/api] Server stopped.');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[alsaqi/api] UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[alsaqi/api] UNHANDLED REJECTION:', reason);
});
