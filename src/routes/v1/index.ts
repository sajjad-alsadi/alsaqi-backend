/**
 * API v1 Router
 *
 * Registers all route modules under the /api/v1/ prefix.
 * This is the single versioned router that aggregates all API endpoints.
 *
 * Route modules are imported from the sibling directory (packages/api/src/routes/).
 * Dependencies (db, middleware, services) are injected via the V1RouterDeps interface.
 */

import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ApiServerConfig } from '../../index.js';
import type { IDBWrapper } from '../../db/index.js';
import type { PermissionAction } from '../../permissions/types.js';
import type { UploadedFile } from 'express-fileupload';

// Route factory imports
import { createAuthRoutes } from '../auth/index.js';
import { createUserRoutes } from '../users.js';
import { createRoleRoutes } from '../roles.js';
import { createJobTitleRoutes } from '../jobTitles.js';
import { createSessionRoutes } from '../sessions.js';
import { createLogRoutes } from '../logs.js';
import { createSettingsRoutes } from '../settings.js';
import { createPdfTemplatesRoutes } from '../pdfTemplates.js';
import { createProfileRoutes } from '../profile.js';
import { createDashboardRoutes } from '../dashboard.js';
import { createCorrespondenceRoutes } from '../correspondence.js';
import { createOrgEntitiesRoutes } from '../orgEntities.js';
import { createCoiRoutes } from '../coi.js';
import { createPoliciesRoutes } from '../policies.js';
import { createAppSettingsRoutes } from '../appSettings.js';
import { createExecutiveReportsRoutes } from '../executiveReports.js';
import { createDepartmentRoutes } from '../departments.js';
import { createAnalyticsRoutes } from '../analytics.js';
import { createIntegrityRoutes } from '../integrity.js';
import { createAuditProgramRoutes } from '../auditPrograms.js';
import { createFraudRoutes } from '../fraud.js';
import { createComplianceRoutes } from '../compliance.js';
import { createNotificationRoutes } from '../notifications.js';
import { createCommentRoutes } from '../comments.js';
import { createAuditTaskRoutes } from '../auditTasks.js';
import { createRecommendationRoutes } from '../recommendations.js';
import { createAuditFindingRoutes } from '../auditFindings.js';
import { createHealthRouter } from '../health.js';
import { createBulkRoutes } from '../bulk.js';
import { createAdminBackupRoutes } from '../adminBackup.js';
import { createPermissionAdminRoutes } from '../permissionAdmin.js';
import { createArchiveRoutes } from '../archive.js';
import { createLookupRoutes } from '../lookups.js';
import { createReportsRoutes } from '../reports.js';
import type { ReportQueueService, ReportStorageService } from '../reports.js';
import { createWebVitalsRoutes } from '../webVitals.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExpressMiddleware = (req: any, res: Response, next: NextFunction) => any;

/**
 * Dependencies required to create the v1 router.
 * These are injected by the server factory (createApiServer)
 * once services and middleware are initialized (task 3.4).
 */
export interface V1RouterDeps {
  db: IDBWrapper;
  authenticate: ExpressMiddleware;
  authorize: (allowedRoles: readonly string[]) => ExpressMiddleware;
  checkPermission: (module: string, action: PermissionAction) => ExpressMiddleware;
  authLimiter: ExpressMiddleware;
  createNotification: (
    recipientIds: string | string[] | 'all',
    type: string,
    message: string,
    module: string,
    link: string,
    options?: Record<string, unknown>
  ) => Promise<boolean>;
  createCrudRoutes: (
    db: IDBWrapper,
    authenticate: ExpressMiddleware,
    checkPermission: (module: string, action: PermissionAction) => ExpressMiddleware,
    logError: (err: unknown, module?: string) => Promise<void>,
    createNotification: V1RouterDeps['createNotification'],
    saveFile: V1RouterDeps['saveFile']
  ) => express.Router;
  saveFile: (file: UploadedFile) => Promise<string>;
  logError: (err: unknown, module?: string) => Promise<void>;
  config: ApiServerConfig;
  idempotencyMiddleware: express.RequestHandler;
  /** Optional: QueueService for report generation (from infrastructure) */
  queueService?: ReportQueueService | null;
  /** Optional: StorageService for presigned download URLs (from infrastructure) */
  storageService?: ReportStorageService | null;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates the v1 router with all API routes registered.
 * Mirrors the route structure from the original `src/server/routes/index.ts`.
 */
export function createV1Router(deps: V1RouterDeps): express.Router {
  const {
    db,
    authenticate,
    authorize,
    checkPermission,
    authLimiter,
    createNotification,
    createCrudRoutes,
    saveFile,
    logError,
    config,
    idempotencyMiddleware,
    queueService,
    storageService,
  } = deps;

  const v1Router = express.Router();

  // Idempotency Middleware (applies to POST/PUT requests with X-Idempotency-Key header)
  v1Router.use(idempotencyMiddleware);

  // Health Check (enhanced - checks all subsystems)
  v1Router.use('/', createHealthRouter());

  // OpenAPI Specification
  v1Router.get('/docs', (req, res) => {
    try {
      const specPath = path.resolve(__dirname, '../../../../docs/openapi.yaml');
      const spec = fs.readFileSync(specPath, 'utf-8');
      res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
      res.send(spec);
    } catch {
      res.status(404).json({ error: 'OpenAPI specification not found' });
    }
  });

  // Auth Routes
  // NOTE: The second positional argument is consumed inside the auth routes as the
  // RS256 verification key (e.g. twoFactor.ts verifies short-lived temp tokens, and
  // SessionService.refresh verifies refresh tokens). Tokens are SIGNED with the RSA
  // private key, so they MUST be verified with the RSA PUBLIC key — never the symmetric
  // `jwtSecret`. Passing `jwtSecret` here previously broke all RS256 verification
  // (the entire 2FA login flow), since an RS256 signature cannot be verified with a
  // symmetric secret string.
  v1Router.use(
    '/auth',
    createAuthRoutes(
      db,
      config.jwtPublicKey,
      config.jwtPrivateKey,
      authLimiter,
      authenticate,
      checkPermission,
      createNotification,
      logError
    )
  );

  // Lookup Routes (must be before CRUD routes to prevent /:id matching "lookup")
  v1Router.use('/', createLookupRoutes(db, authenticate, checkPermission, logError));

  // Generic CRUD API Generator with Auth & Logging
  if (createCrudRoutes) {
    v1Router.use('/', createCrudRoutes(db, authenticate, checkPermission, logError, createNotification, saveFile));
  }

  // Notification Routes
  v1Router.use('/notifications', createNotificationRoutes(db, authenticate));

  // Comments Routes
  v1Router.use('/comments', createCommentRoutes(db, authenticate, checkPermission, logError));

  // Modular Routes
  v1Router.use('/job-titles', createJobTitleRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/users', createUserRoutes(db, authenticate, authorize, checkPermission, logError));
  v1Router.use('/', createRoleRoutes(db, authenticate, authorize, checkPermission, logError));
  v1Router.use('/user-sessions', createSessionRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/', createLogRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/', createSettingsRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/', createPdfTemplatesRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/', createProfileRoutes(db, authenticate, authorize, logError));
  v1Router.use('/', createDashboardRoutes(db, authenticate, authorize, logError));
  v1Router.use('/correspondence', createCorrespondenceRoutes(db, authenticate, checkPermission, logError, saveFile));
  v1Router.use('/', createOrgEntitiesRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/', createCoiRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/', createPoliciesRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/', createAppSettingsRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/', createExecutiveReportsRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/departments', createDepartmentRoutes(db, authenticate, checkPermission, logError));

  // Analytics & Specialized Routes
  v1Router.use('/analytics', createAnalyticsRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/', createIntegrityRoutes(authenticate));
  v1Router.use('/audit-programs', createAuditProgramRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/audit-tasks', createAuditTaskRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/audit-findings', createAuditFindingRoutes(db, authenticate, checkPermission, logError));
  v1Router.use('/recommendations', createRecommendationRoutes(db, authenticate, checkPermission, logError));

  // Archive Routes
  v1Router.use('/', createArchiveRoutes(db, authenticate, checkPermission, logError));

  // Domain-Specific Routes
  v1Router.use('/fraud-access-requests', createFraudRoutes(db, authenticate, checkPermission, logError, createNotification));
  v1Router.use('/compliance', createComplianceRoutes(db, authenticate, checkPermission, logError, saveFile));

  // Bulk Operations
  v1Router.use('/bulk', createBulkRoutes(authenticate, checkPermission));

  // Admin Routes
  v1Router.use('/admin', createAdminBackupRoutes(authenticate, checkPermission));

  // Permission Admin Routes
  v1Router.use('/', createPermissionAdminRoutes(db, authenticate, checkPermission, logError));

  // Report Generation Routes (PDF report generation and status tracking)
  v1Router.use('/reports', createReportsRoutes(db, authenticate, checkPermission, logError, queueService, storageService));

  // Web Vitals Metrics (unauthenticated — frontend reports before/during login)
  v1Router.use('/metrics', createWebVitalsRoutes());

  return v1Router;
}
