import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "../db/index";
import { createAuthMiddlewares } from "../middleware/auth";
import { createAuthRoutes } from "./auth";
import { createUserRoutes } from "./users";
import { createRoleRoutes } from "./roles";
import { createJobTitleRoutes } from "./jobTitles";
import { createSessionRoutes } from "./sessions";
import { createLogRoutes } from "./logs";
import { createSettingsRoutes } from "./settings";
import { createPdfTemplatesRoutes } from "./pdfTemplates";
import { createProfileRoutes } from "./profile";
import { createDashboardRoutes } from "./dashboard";
import { createCorrespondenceRoutes } from "./correspondence";
import { createOrgEntitiesRoutes } from "./orgEntities";
import { createCoiRoutes } from "./coi";
import { createPoliciesRoutes } from "./policies";
import { createAppSettingsRoutes } from "./appSettings";
import { createExecutiveReportsRoutes } from "./executiveReports";
import { createDepartmentRoutes } from "./departments";
import { createCrudRoutes } from "../utils/crudGenerator";
import { createAnalyticsRoutes } from "./analytics";
import { createIntegrityRoutes } from "./integrity";
import { createAuditProgramRoutes } from "./auditPrograms";
import { createFraudRoutes } from "./fraud";
import { createComplianceRoutes } from "./compliance";
import { createNotificationRoutes } from "./notifications";
import { createCommentRoutes } from "./comments";
import { createAuditTaskRoutes } from "./auditTasks";
import { createRecommendationRoutes } from "./recommendations";
import { createAuditFindingRoutes } from "./auditFindings";
import { NotificationService } from "../services/NotificationService";
import { logDuplicateRoutes, registerRoutes } from "../utils/routeRegistry";
import { createHealthRouter } from "./health";
import { createBulkRoutes } from "./bulk";
import { createAdminBackupRoutes } from "./adminBackup";
import { createPermissionAdminRoutes } from "./permissionAdmin";
import { createArchiveRoutes } from "./archive";
import { createLookupRoutes } from "./lookups";
import { createIdempotencyMiddleware } from "../middleware/idempotency";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createNotification = NotificationService.create.bind(NotificationService);

/**
 * Current supported API version.
 * Used for the X-API-Version header and version routing.
 */
export const CURRENT_API_VERSION = { major: 1, minor: 0 };
export const SUPPORTED_VERSIONS = [1];

export const setupRoutes = (
  app: express.Application,
  JWT_SECRET: string,
  JWT_PRIVATE_KEY: string,
  JWT_PUBLIC_KEY: string,
  saveFile: any,
  logError: any
) => {
  // API Version Header - set on all /api/ responses
  app.use('/api/', (req: any, res: any, next: any) => {
    res.setHeader('X-API-Version', `${CURRENT_API_VERSION.major}.${CURRENT_API_VERSION.minor}`);
    next();
  });

  // ─── Unsupported Version Handler ─────────────────────────────────────────
  // Intercept requests to /api/v{n}/ where n is not a supported version.
  // Must be registered BEFORE the fallback and versioned routes.
  app.use('/api/v:version', (req: any, res: any, next: any) => {
    const versionStr = req.params.version;
    // Extract just the numeric part (e.g., "2" from "2/something")
    const versionNum = parseInt(versionStr, 10);

    if (isNaN(versionNum) || versionNum < 1 || !Number.isInteger(Number(versionStr))) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'VERSION_NOT_FOUND',
          message: `API version 'v${versionStr}' is not available. Supported versions: ${SUPPORTED_VERSIONS.map(v => `v${v}`).join(', ')}`,
        },
      });
    }

    if (!SUPPORTED_VERSIONS.includes(versionNum)) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'VERSION_NOT_FOUND',
          message: `API version 'v${versionNum}' is not available. Supported versions: ${SUPPORTED_VERSIONS.map(v => `v${v}`).join(', ')}`,
        },
      });
    }

    // Supported version - continue to actual route handlers
    next();
  });

  // ─── Version Fallback ────────────────────────────────────────────────────
  // Requests to /api/{resource} (without version prefix) are rewritten to /api/v1/{resource}.
  // This ensures backward compatibility - existing clients using /api/resource still work.
  app.use('/api', (req: any, res: any, next: any) => {
    // If the path already starts with /v{n}/, let it pass through
    if (/^\/v\d+/.test(req.path)) {
      return next();
    }

    // Rewrite the URL to include the version prefix
    req.url = `/v${CURRENT_API_VERSION.major}${req.url === '/' ? '' : req.url}`;
    next();
  });

  // ─── Versioned Router (v1) ───────────────────────────────────────────────
  // All API routes are mounted under /api/v1/
  const v1Router = express.Router();

  // Auth Middleware
  const { authenticate, checkPermission, authorize, authLimiter } = createAuthMiddlewares(db, JWT_SECRET, JWT_PUBLIC_KEY);

  // Idempotency Middleware (applies to POST/PUT requests with X-Idempotency-Key header)
  // Must be after auth since it scopes keys per authenticated user
  v1Router.use(createIdempotencyMiddleware());

  // Health Check (enhanced - checks all subsystems)
  v1Router.use("/", createHealthRouter());

  // OpenAPI Specification
  v1Router.get("/docs", (req, res) => {
    try {
      const specPath = path.resolve(__dirname, '../../../docs/openapi.yaml');
      const spec = fs.readFileSync(specPath, 'utf-8');
      res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
      res.send(spec);
    } catch (err) {
      res.status(404).json({ error: 'OpenAPI specification not found' });
    }
  });

  // Auth Routes
  v1Router.use("/auth", createAuthRoutes(db, JWT_SECRET, JWT_PRIVATE_KEY, authLimiter, authenticate, checkPermission, createNotification, logError));
  
  // Lookup Routes (simplified data for dropdowns in forms)
  // Must be registered BEFORE CRUD routes to prevent /:id pattern from matching "lookup"
  v1Router.use("/", createLookupRoutes(db, authenticate, checkPermission, logError));

  // Generic CRUD API Generator with Auth & Logging
  v1Router.use("/", createCrudRoutes(db, authenticate, checkPermission, logError, createNotification, saveFile));

  // Notification Routes
  v1Router.use("/notifications", createNotificationRoutes(db, authenticate));
  
  // Comments Routes
  v1Router.use("/comments", createCommentRoutes(db, authenticate, logError));

  // Modular Routes
  v1Router.use("/job-titles", createJobTitleRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/users", createUserRoutes(db, authenticate, authorize, checkPermission, logError));
  v1Router.use("/", createRoleRoutes(db, authenticate, authorize, checkPermission, logError));
  v1Router.use("/user-sessions", createSessionRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/", createLogRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/", createSettingsRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/", createPdfTemplatesRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/", createProfileRoutes(db, authenticate, authorize, logError));
  v1Router.use("/", createDashboardRoutes(db, authenticate, authorize, logError));
  v1Router.use("/correspondence", createCorrespondenceRoutes(db, authenticate, checkPermission, logError, saveFile));
  v1Router.use("/", createOrgEntitiesRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/", createCoiRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/", createPoliciesRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/", createAppSettingsRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/", createExecutiveReportsRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/departments", createDepartmentRoutes(db, authenticate, checkPermission, logError));
  
  // Newly Extracted Routes
  v1Router.use("/analytics", createAnalyticsRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/", createIntegrityRoutes(authenticate));
  v1Router.use("/audit-programs", createAuditProgramRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/audit-tasks", createAuditTaskRoutes(db, authenticate, logError));
  v1Router.use("/audit-findings", createAuditFindingRoutes(db, authenticate, checkPermission, logError));
  v1Router.use("/recommendations", createRecommendationRoutes(db, authenticate, logError));

  // Archive Routes (audit plan archiving and archived plan retrieval)
  v1Router.use("/", createArchiveRoutes(db, authenticate, checkPermission, logError));

  v1Router.use("/fraud-access-requests", createFraudRoutes(db, authenticate, checkPermission, logError, createNotification));
  v1Router.use("/compliance", createComplianceRoutes(db, authenticate, checkPermission, logError, saveFile));

  // Bulk Operations
  v1Router.use("/bulk", createBulkRoutes(authenticate));

  // Admin Routes
  v1Router.use("/admin", createAdminBackupRoutes(authenticate, checkPermission));

  // Permission Admin Routes (role management, permission matrix, user overrides, audit logs)
  v1Router.use("/", createPermissionAdminRoutes(db, authenticate, checkPermission, logError));

  // Mount the v1 router under /api/v1
  app.use("/api/v1", v1Router);

  // Register custom routes in the route registry for duplicate detection
  registerRoutes(['GET', 'POST', 'PUT', 'DELETE'], '/api/v1/audit-programs', 'auditPrograms.ts');
  registerRoutes(['GET', 'POST', 'PUT', 'DELETE'], '/api/v1/audit-findings', 'auditFindings.ts');
  registerRoutes(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], '/api/v1/audit-tasks', 'auditTasks.ts');
  registerRoutes(['POST'], '/api/v1/audit-tasks/:id/assign', 'auditTasks.ts');
  registerRoutes(['DELETE'], '/api/v1/audit-tasks/:id/assign/:userId', 'auditTasks.ts');
  registerRoutes(['POST', 'PATCH'], '/api/v1/recommendations', 'recommendations.ts');
  registerRoutes(['POST', 'GET'], '/api/v1/audit-findings/:findingId/evidence', 'auditFindings.ts');

  // Detect and log duplicate route registrations at startup
  logDuplicateRoutes();

  // Global API 404 Handler - MUST be after all API routes
  // Handles both /api/v1/unknown and /api/unknown (which gets rewritten to /api/v1/unknown)
  app.use("/api", (req, res) => {
    res.status(404).json({ error: `API endpoint ${req.originalUrl} not found` });
  });
};
