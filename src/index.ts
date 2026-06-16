/**
 * @alsaqi/api - Independent API Server Package
 *
 * This module exports the createApiServer factory function that produces
 * an ApiServer instance with lifecycle management (start/stop) and
 * access to the underlying Express app and HTTP server.
 */

import express from 'express';
import http from 'http';
import cookieParser from 'cookie-parser';
import fileUpload from 'express-fileupload';
import { WebSocketServer } from 'ws';
import { API_VERSION } from '@alsaqi/shared';

// Middleware
import { createCorsMiddleware } from './middleware/cors.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { apiVersionMiddleware } from './middleware/apiVersion.js';
import { createCorrelationIdMiddleware } from './middleware/correlationId.js';
import { requestLoggerMiddleware } from './middleware/requestLogger.js';
import { createResponseWrapper } from './middleware/responseWrapper.js';
import { createCompressionMiddleware } from './middleware/compression.js';
import { createHelmetMiddleware } from './middleware/helmet.js';
import { globalErrorHandler } from './middleware/error.js';
import { bodySizeLimit } from './middleware/validate.js';
import {
  apiVersionHeader,
  unsupportedVersionHandler,
  versionFallbackRewrite,
  CURRENT_API_VERSION,
  SUPPORTED_VERSIONS,
} from './middleware/versionRewrite.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';

// Routes
import { createV1Router } from './routes/v1/index.js';
import type { V1RouterDeps } from './routes/v1/index.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApiServerConfig {
  port: number;
  corsOrigins: string[];
  jwtSecret: string;
  jwtPrivateKey: string;
  jwtPublicKey: string;
  databaseUrl: string;
  uploadDir: string;
  nodeEnv: 'development' | 'production' | 'test';
}

export interface ApiServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getApp(): express.Application;
  getHttpServer(): http.Server;
}

// Re-export useful constants
export { CURRENT_API_VERSION, SUPPORTED_VERSIONS };

// Re-export response envelope utilities
export { createSuccessResponse, createErrorResponse, computePagination } from './utils/responseEnvelope.js';
export type { SuccessOptions, ErrorOptions, PaginationInput } from './utils/responseEnvelope.js';

// Re-export route registration (for wiring in start())
export { createV1Router } from './routes/v1/index.js';
export type { V1RouterDeps } from './routes/v1/index.js';

// ─── Infrastructure Feature Flags ──────────────────────────────────────────────

/**
 * Resolves whether an optional infrastructure subsystem should be wired during
 * startup. Each subsystem (Redis, queues, WebSocket, cron/backups, metrics) is
 * gated behind an explicit environment flag so a fully-configured deployment
 * boots them while constrained environments (e.g. tests) can opt out without a
 * code change.
 *
 * An unset/blank flag falls back to `defaultEnabled`; an explicit
 * `false`/`0`/`off`/`no`/`disabled` (case-insensitive) disables the subsystem,
 * any other value enables it.
 */
function isFeatureEnabled(rawFlag: string | undefined, defaultEnabled: boolean): boolean {
  if (rawFlag === undefined || rawFlag.trim() === '') {
    return defaultEnabled;
  }
  const normalized = rawFlag.trim().toLowerCase();
  return !['false', '0', 'off', 'no', 'disabled'].includes(normalized);
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates an API server instance with full lifecycle management.
 *
 * The server does NOT start listening until `start()` is called.
 * Call `stop()` for graceful shutdown with a 10-second timeout
 * for in-flight requests.
 *
 * The API server SHALL NOT serve any static files or frontend assets.
 */
export function createApiServer(config: ApiServerConfig): ApiServer {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Track active connections for graceful shutdown
  const activeConnections = new Set<import('net').Socket>();

  // Cleanup handle for the WebSocket subsystem (heartbeat interval + upgrade
  // listener). Populated when setupWebSocket() is wired in start(); invoked by
  // stop() so the heartbeat timer does not outlive the server.
  let wsCleanup: (() => void) | null = null;

  server.on('connection', (socket) => {
    activeConnections.add(socket);
    socket.on('close', () => {
      activeConnections.delete(socket);
    });
  });

  // Expose WebSocket server to routes via app
  (app as any).wss = wss;

  // Store config on app for middleware/routes to access
  (app as any).serverConfig = config;

  // ─── Middleware Stack ─────────────────────────────────────────────────────────

  // 0. Trust proxy - required for correct X-Forwarded-For IP extraction behind Load Balancer
  //    Requirement 8.1: Extract real client IP from X-Forwarded-For
  app.set('trust proxy', 1);

  // 1. Compression (before other middleware for optimal compression)
  app.use(createCompressionMiddleware());

  // 2. Security headers (Helmet)
  app.use(createHelmetMiddleware(config.nodeEnv));

  // 3. CORS - accepts only configured origins; no wildcard in production
  //    Reads from config.corsOrigins which comes from CORS_ORIGIN env variable
  app.use(createCorsMiddleware({
    allowedOrigins: config.corsOrigins,
    nodeEnv: config.nodeEnv,
  }));

  // 4. Body parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  // 4a. Multipart/form-data parsing (file uploads). Registered so attachment
  //     routes (e.g. /api/correspondence/attachments, /api/compliance,
  //     audit-finding evidence) can read req.files; without this, req.files is
  //     always undefined and uploads silently fail (Finding 1.30 → 2.30). Kept in
  //     memory (useTempFiles:false) so the downstream Magika deep-inspection in
  //     saveFile still sees file.data. abortOnLimit rejects oversized uploads, and
  //     the file-upload paths are already exempt from the 1 MB JSON body limit in
  //     bodySizeLimit below.
  app.use(
    fileUpload({
      limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
      abortOnLimit: true,
      responseOnLimit: 'File size limit exceeded (maximum 25 MB)',
      useTempFiles: false,
      createParentPath: true,
      preserveExtension: true,
      safeFileNames: true,
    })
  );

  // 5. Body size limit enforcement
  app.use(bodySizeLimit);

  // 6. Correlation ID (request tracing - generates UUID v4 per request)
  app.use(createCorrelationIdMiddleware());

  // 6a. Request logging (records method/path/status/duration to request_logs and
  //     warns on slow requests). Mounted AFTER correlation ID so every log entry
  //     carries the request's correlation ID. Excludes /api/health and /uploads/*
  //     by default; DB persist failures degrade to stderr without affecting the
  //     response (Finding 1.16 → 2.16).
  app.use(requestLoggerMiddleware);

  // 7. X-API-Version header on all /api/ responses
  app.use('/api/', apiVersionHeader);
  app.use(apiVersionMiddleware);

  // 8. Response wrapper (wraps all JSON responses in ApiResponse envelope)
  app.use(createResponseWrapper());

  // 9. Rate limiting on /api paths (sliding window: 100 req/60s authenticated, 50 req/60s unauth)
  app.use('/api', createRateLimiter({
    authenticatedLimit: 100,
    unauthenticatedLimit: 50,
    windowSeconds: 60,
  }));

  // 10. CSRF validation on state-changing requests (POST, PUT, PATCH, DELETE)
  //     Exempt endpoints: login, refresh token, register
  app.use('/api', csrfMiddleware({
    exemptPaths: [
      '/api/auth/login',
      '/api/auth/refresh',
      '/api/auth/register',
      '/api/v1/auth/login',
      '/api/v1/auth/refresh',
      '/api/v1/auth/register',
    ],
    tokenHeader: 'x-csrf-token',
    cookieName: 'csrf-token',
    tokenByteLength: 32,
  }));

  // ─── Middleware: Unsupported Version Handler ─────────────────────────────────
  // Must be registered BEFORE the fallback and versioned routes
  app.use('/api/', unsupportedVersionHandler);

  // ─── Middleware: Version Fallback Rewrite ────────────────────────────────────
  // Requests to /api/{resource} (no version prefix) internally rewrite to /api/v1/{resource}
  app.use('/api', versionFallbackRewrite);

  // ─── Health Check ───────────────────────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ─── Versioned Routes (v1) ──────────────────────────────────────────────────
  // Route registration is deferred to start() where DB and middleware are initialized.
  // The not-found and error handlers are also deferred so they appear AFTER routes.

  // ─── start() ────────────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    // Fail-fast configuration assertion (Req 9.1, 9.2, 2.11): verify the
    // dedicated FILE_ACCESS_SECRET is present and at least 32 characters, and
    // (in production) that FILE_ENCRYPTION_KEY and TOTP_ENCRYPTION_KEY are set,
    // BEFORE binding the port. assertConfigured logs a fatal error and exits
    // with a non-zero code when a required secret/key is missing or too short.
    const { SecureFileService } = await import('./services/SecureFileService.js');
    SecureFileService.assertConfigured();

    // Initialize database connection and run pending migrations
    const { initDb, db } = await import('./db/index.js');
    const { runMigrations, versionedMigrations } = await import('./db/migrations.js');
    const { MigrationRunner } = await import('./db/migrationRunner.js');

    await initDb();
    await runMigrations();

    // Run versioned migrations via MigrationRunner
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.run(versionedMigrations);

    // ─── Auto-generate RSA keys if not provided ─────────────────────────────────
    // In development, generate keys on startup; in production, use KeyStore for
    // persistent encrypted storage.
    let jwtPrivateKey = config.jwtPrivateKey;
    let jwtPublicKey = config.jwtPublicKey;

    if (!jwtPrivateKey || !jwtPublicKey || !jwtPrivateKey.includes('-----BEGIN') || !jwtPublicKey.includes('-----BEGIN')) {
      const { KeyStore } = await import('./utils/keyStore.js');
      const keyStore = new KeyStore({
        dataDir: process.env.DATA_DIR || './data',
        encryptionSecret: config.jwtSecret,
      });
      const keys = await keyStore.getOrCreate();
      jwtPrivateKey = keys.privateKey;
      jwtPublicKey = keys.publicKey;
    }

    // ─── Mount Versioned Routes (v1) ──────────────────────────────────────────
    // Routes are registered AFTER DB initialization since they need the db instance
    // and auth middleware (which depends on DB for user/permission lookups).
    const { createAuthMiddlewares } = await import('./middleware/auth.js');
    const { createIdempotencyMiddleware } = await import('./middleware/idempotency.js');
    const { NotificationService } = await import('./services/NotificationService.js');
    const { createCrudRoutes } = await import('./utils/crudGenerator.js');
    const { createSaveFile, createLogError } = await import('./utils/serverUtils.js');

    // Side-effect import: registers all permission modules in ModuleRegistry
    // Must be imported BEFORE createAuthMiddlewares is used (checkPermission validates modules)
    await import('./permissions/modules.js');

    const { authenticate, authorize, checkPermission, authLimiter } = createAuthMiddlewares(
      db,
      config.jwtSecret,
      jwtPublicKey
    );

    const saveFile = createSaveFile(config.uploadDir);
    const logError = createLogError(db);
    const createNotification = NotificationService.create.bind(NotificationService);

    const v1Router = createV1Router({
      db,
      authenticate,
      authorize,
      checkPermission,
      authLimiter,
      createNotification,
      createCrudRoutes,
      saveFile,
      logError,
      config: { ...config, jwtPrivateKey, jwtPublicKey },
      idempotencyMiddleware: createIdempotencyMiddleware(),
    });

    app.use('/api/v1', v1Router);

    // ─── Not Found Handler ──────────────────────────────────────────────────────
    // MUST be registered AFTER all API routes.
    app.use('/api', notFoundHandler);

    // ─── Global Error Handler ───────────────────────────────────────────────────
    // Must be last middleware (4 params = error handler)
    app.use(globalErrorHandler);

    // ─── Infrastructure Composition (Finding 1.1 → 2.1) ──────────────────────────
    // Wire the background infrastructure subsystems into startup so WebSockets,
    // queues, Redis-backed rate limiting, cron/backups, and metrics all function.
    // Each subsystem is gated behind an explicit env flag (default ON outside the
    // test environment) so a fully-configured deployment boots them while
    // constrained environments can intentionally opt out (Preservation 3.6, 3.11).
    const infraDefault = config.nodeEnv !== 'test';

    // Redis connection (rate limiter / cache backend). Degrades gracefully on its own.
    if (isFeatureEnabled(process.env.ENABLE_REDIS, infraDefault)) {
      const { redisManager } = await import('./cache/redisManager.js');
      await redisManager.connect();
    }

    // BullMQ queues + notification/PDF queue workers.
    if (isFeatureEnabled(process.env.ENABLE_QUEUES, infraDefault)) {
      const { queueManager } = await import('./queues/queueManager.js');
      await queueManager.initialize();

      const { startNotificationWorker } = await import('./queues/workers/notificationWorker.js');
      const { registerPdfWorker } = await import('./queues/workers/pdfWorker.js');
      startNotificationWorker(queueManager);
      registerPdfWorker();
    }

    // WebSocket server (real-time notifications + heartbeat).
    if (isFeatureEnabled(process.env.ENABLE_WEBSOCKET, infraDefault)) {
      const { setupWebSocket } = await import('./ws/index.js');
      wsCleanup = setupWebSocket({
        httpServer: server,
        wss,
        jwtPublicKey,
      });
    }

    // Scheduled automation (cron) + automated backups.
    if (isFeatureEnabled(process.env.ENABLE_CRON, infraDefault)) {
      const { startAutomationJobs } = await import('./cron/index.js');
      const { backupScheduler } = await import('./utils/backup.js');
      startAutomationJobs();
      // startAutomationJobs() already starts the backup scheduler; BackupScheduler.start()
      // is idempotent (it stops any previous schedule first), so this explicit call keeps
      // the daily backups running without creating a second schedule.
      backupScheduler.start();
    }

    // Prometheus metrics endpoint.
    if (isFeatureEnabled(process.env.ENABLE_METRICS, infraDefault)) {
      const { metricsHandler } = await import('./monitoring/metricsServer.js');
      // Access control for /metrics (finding 1.40 → 2.40): metrics must not be
      // scrapeable by anonymous public clients. When METRICS_TOKEN is configured,
      // require a matching bearer token; otherwise restrict scraping to loopback
      // addresses (the common sidecar/host-scrape topology) so the endpoint is
      // never exposed unauthenticated on a public interface.
      const metricsToken = process.env.METRICS_TOKEN;
      app.get(
        '/metrics',
        (req, res, next) => {
          if (metricsToken) {
            if (req.headers['authorization'] === `Bearer ${metricsToken}`) {
              return next();
            }
            return res.status(401).json({ error: 'Unauthorized' });
          }
          const ip = req.ip || req.socket.remoteAddress || '';
          if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
            return next();
          }
          return res.status(403).json({ error: 'Forbidden' });
        },
        metricsHandler
      );
    }

    return new Promise<void>((resolve, reject) => {
      // Handle port-in-use and other listen errors
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${config.port} is already in use`));
        } else {
          reject(err);
        }
      };

      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);

      server.listen(config.port, '0.0.0.0');
    });
  }

  // ─── stop() ─────────────────────────────────────────────────────────────────

  async function stop(): Promise<void> {
    const SHUTDOWN_TIMEOUT_MS = 10_000;

    return new Promise<void>((resolve) => {
      // Stop the WebSocket heartbeat timer and remove the upgrade listener so it
      // does not outlive the server (no-op if WebSocket was never wired).
      if (wsCleanup) {
        try {
          wsCleanup();
        } catch {
          // Best-effort cleanup; ignore errors during shutdown.
        }
        wsCleanup = null;
      }

      // Stop accepting new connections
      server.close(() => {
        // All connections drained gracefully
        resolve();
      });

      // Close all WebSocket connections
      wss.clients.forEach((client) => {
        client.close(1001, 'Server shutting down');
      });

      // Force-close remaining connections after timeout
      const forceShutdownTimer = setTimeout(() => {
        // Forcefully destroy any remaining TCP connections
        for (const socket of activeConnections) {
          socket.destroy();
        }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);

      // Don't let the timer keep the process alive if everything closes cleanly
      forceShutdownTimer.unref();
    });
  }

  // ─── Accessors ──────────────────────────────────────────────────────────────

  function getApp(): express.Application {
    return app;
  }

  function getHttpServer(): http.Server {
    return server;
  }

  return {
    start,
    stop,
    getApp,
    getHttpServer,
  };
}
