// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Unit Tests - API Versioning (Task 4.1)
 *
 * Tests the API versioning implementation:
 * - Routes are accessible under /api/v1/ prefix
 * - Requests to /api/ without version prefix fallback to v1
 * - X-API-Version response header is set to "1.0"
 * - Unsupported version segments return 404
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4
 */

// Use vi.hoisted to create mock factory that can be referenced in vi.mock calls
const { mockRouter } = vi.hoisted(() => {
  // We need a minimal express import for the mock router
  return {
    mockRouter: (routePath: string, method = 'get') => {
      return (..._args: any[]) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const expressModule = require('express');
        const router = expressModule.Router();
        router[method]('/', (req: any, res: any) => {
          res.json({ route: routePath });
        });
        return router;
      };
    },
  };
});

// Mock all heavy dependencies to isolate versioning logic
vi.mock('../../db/index', () => ({
  db: {
    isExternal: false,
    client: { dataDir: '/tmp/test' },
    prepare: vi.fn(() => ({
      get: vi.fn().mockResolvedValue({ check_val: 1 }),
      all: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

vi.mock('../../middleware/auth', () => ({
  createAuthMiddlewares: () => ({
    authenticate: (req: any, res: any, next: any) => {
      req.user = { id: 'test-user', role: 'Admin', username: 'test' };
      next();
    },
    checkPermission: () => (req: any, res: any, next: any) => next(),
    authorize: () => (req: any, res: any, next: any) => next(),
    authLimiter: (req: any, res: any, next: any) => next(),
  }),
}));

vi.mock('../../services/NotificationService', () => ({
  NotificationService: {
    create: vi.fn(),
  },
}));

vi.mock('../../utils/routeRegistry', () => ({
  registerRoutes: vi.fn(),
  logDuplicateRoutes: vi.fn().mockReturnValue([]),
  methodNotAllowed: (methods: string[]) => (req: any, res: any, next: any) => {
    if (!methods.includes(req.method.toUpperCase())) {
      res.status(405).json({ error: 'Method Not Allowed' });
    } else {
      next();
    }
  },
}));

// Mock all route creators to return simple routers
vi.mock('../auth', () => ({ createAuthRoutes: mockRouter('/auth') }));
vi.mock('../users', () => ({ createUserRoutes: mockRouter('/users') }));
vi.mock('../roles', () => ({ createRoleRoutes: () => require('express').Router() }));
vi.mock('../jobTitles', () => ({ createJobTitleRoutes: mockRouter('/job-titles') }));
vi.mock('../sessions', () => ({ createSessionRoutes: mockRouter('/sessions') }));
vi.mock('../logs', () => ({ createLogRoutes: () => require('express').Router() }));
vi.mock('../settings', () => ({ createSettingsRoutes: () => require('express').Router() }));
vi.mock('../pdfTemplates', () => ({ createPdfTemplatesRoutes: () => require('express').Router() }));
vi.mock('../profile', () => ({ createProfileRoutes: () => require('express').Router() }));
vi.mock('../dashboard', () => ({ createDashboardRoutes: () => require('express').Router() }));
vi.mock('../correspondence', () => ({ createCorrespondenceRoutes: mockRouter('/correspondence') }));
vi.mock('../orgEntities', () => ({ createOrgEntitiesRoutes: () => require('express').Router() }));
vi.mock('../coi', () => ({ createCoiRoutes: () => require('express').Router() }));
vi.mock('../policies', () => ({ createPoliciesRoutes: () => require('express').Router() }));
vi.mock('../appSettings', () => ({ createAppSettingsRoutes: () => require('express').Router() }));
vi.mock('../executiveReports', () => ({ createExecutiveReportsRoutes: () => require('express').Router() }));
vi.mock('../departments', () => ({ createDepartmentRoutes: mockRouter('/departments') }));
vi.mock('../analytics', () => ({ createAnalyticsRoutes: mockRouter('/analytics') }));
vi.mock('../integrity', () => ({ createIntegrityRoutes: () => require('express').Router() }));
vi.mock('../auditPrograms', () => ({ createAuditProgramRoutes: mockRouter('/audit-programs') }));
vi.mock('../fraud', () => ({ createFraudRoutes: mockRouter('/fraud') }));
vi.mock('../compliance', () => ({ createComplianceRoutes: mockRouter('/compliance') }));
vi.mock('../notifications', () => ({ createNotificationRoutes: mockRouter('/notifications') }));
vi.mock('../comments', () => ({ createCommentRoutes: mockRouter('/comments') }));
vi.mock('../auditTasks', () => ({ createAuditTaskRoutes: mockRouter('/audit-tasks') }));
vi.mock('../recommendations', () => ({ createRecommendationRoutes: mockRouter('/recommendations') }));
vi.mock('../../utils/crudGenerator', () => ({ createCrudRoutes: () => require('express').Router() }));
vi.mock('../auditFindings', () => ({ createAuditFindingRoutes: () => require('express').Router() }));
vi.mock('../health', () => ({
  createHealthRouter: () => {
    const expressModule = require('express');
    const router = expressModule.Router();
    router.get('/health', (req: any, res: any) => {
      res.json({ status: 'healthy' });
    });
    return router;
  },
}));
vi.mock('../bulk', () => ({ createBulkRoutes: () => require('express').Router() }));
vi.mock('../adminBackup', () => ({ createAdminBackupRoutes: () => require('express').Router() }));
vi.mock('../permissionAdmin', () => ({ createPermissionAdminRoutes: () => require('express').Router() }));
vi.mock('../archive', () => ({ createArchiveRoutes: () => require('express').Router() }));
vi.mock('../lookups', () => ({ createLookupRoutes: () => require('express').Router() }));
vi.mock('../../middleware/idempotency', () => ({ createIdempotencyMiddleware: () => (req: any, res: any, next: any) => next() }));

import { setupRoutes, CURRENT_API_VERSION, SUPPORTED_VERSIONS } from '../index';

function createTestApp() {
  const app = express();
  app.use(express.json());
  setupRoutes(app, 'jwt-secret', 'jwt-private', 'jwt-public', vi.fn(), vi.fn());
  return app;
}

describe('API Versioning (Task 4.1)', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  describe('Requirement 4.1: Version prefix /api/v1/', () => {
    it('should serve health check at /api/v1/health', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(['healthy', 'degraded']).toContain(res.body.status);
    });

    it('should serve routes under /api/v1/ prefix', async () => {
      const res = await request(app).get('/api/v1/auth');
      expect(res.status).toBe(200);
      expect(res.body.route).toBe('/auth');
    });
  });

  describe('Requirement 4.2: Fallback from /api/ to current version (v1)', () => {
    it('should route /api/health to v1 health check', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(['healthy', 'degraded']).toContain(res.body.status);
    });

    it('should route /api/auth to /api/v1/auth', async () => {
      const res = await request(app).get('/api/auth');
      expect(res.status).toBe(200);
      expect(res.body.route).toBe('/auth');
    });

    it('should route /api/notifications to /api/v1/notifications', async () => {
      const res = await request(app).get('/api/notifications');
      expect(res.status).toBe(200);
      expect(res.body.route).toBe('/notifications');
    });
  });

  describe('Requirement 4.3: X-API-Version response header', () => {
    it('should set X-API-Version header to "1.0" on /api/v1/ responses', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.headers['x-api-version']).toBe('1.0');
    });

    it('should set X-API-Version header on /api/ fallback responses', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-api-version']).toBe('1.0');
    });

    it('should set X-API-Version header on 404 responses for unsupported versions', async () => {
      const res = await request(app).get('/api/v2/health');
      expect(res.headers['x-api-version']).toBe('1.0');
    });
  });

  describe('Requirement 4.4: 404 for unsupported version segments', () => {
    it('should return 404 for /api/v2/', async () => {
      const res = await request(app).get('/api/v2/health');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VERSION_NOT_FOUND');
      expect(res.body.error.message).toContain('v2');
      expect(res.body.error.message).toContain('v1');
    });

    it('should return 404 for /api/v99/', async () => {
      const res = await request(app).get('/api/v99/anything');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VERSION_NOT_FOUND');
    });

    it('should return 404 for /api/v0/ (version must be positive)', async () => {
      const res = await request(app).get('/api/v0/health');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VERSION_NOT_FOUND');
    });

    it('should return 404 for non-numeric version like /api/vabc/', async () => {
      const res = await request(app).get('/api/vabc/health');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VERSION_NOT_FOUND');
    });
  });

  describe('Exported constants', () => {
    it('should export CURRENT_API_VERSION with major and minor', () => {
      expect(CURRENT_API_VERSION).toEqual({ major: 1, minor: 0 });
    });

    it('should export SUPPORTED_VERSIONS containing version 1', () => {
      expect(SUPPORTED_VERSIONS).toContain(1);
    });
  });

  describe('Backward compatibility', () => {
    it('should return 404 for completely unknown API paths', async () => {
      const res = await request(app).get('/api/nonexistent-endpoint-xyz');
      expect(res.status).toBe(404);
    });

    it('should return 404 for unknown paths under /api/v1/', async () => {
      const res = await request(app).get('/api/v1/nonexistent-endpoint-xyz');
      expect(res.status).toBe(404);
    });
  });
});
