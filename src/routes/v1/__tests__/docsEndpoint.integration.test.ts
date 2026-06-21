// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { load as loadYaml } from 'js-yaml';

/**
 * Integration Test - Docs_Endpoint serving (Task 7.4)
 *
 * Confirms that `GET /api/v1/docs` returns HTTP 200 and a parseable OpenAPI body.
 * The endpoint serves `docs/openapi.yaml` (provided by task 7.1) as a YAML body.
 * This test builds the live v1 router with stubbed dependencies (mirroring the
 * app-construction pattern in `src/routes/__tests__/apiVersioning.test.ts`),
 * requests the docs endpoint, parses the body as YAML, and asserts the parsed
 * document has an `openapi` version field and a `paths` object.
 *
 * Validates: Requirements 10.1
 */

// Mock heavy route-module dependencies so the v1 router can be constructed in
// isolation. We only exercise the `/docs` route, so every other route module is
// replaced with a trivial empty router.
vi.mock('../../../db/index', () => ({
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

vi.mock('../../auth/index', () => ({ createAuthRoutes: () => require('express').Router() }));
vi.mock('../../users', () => ({ createUserRoutes: () => require('express').Router() }));
vi.mock('../../roles', () => ({ createRoleRoutes: () => require('express').Router() }));
vi.mock('../../jobTitles', () => ({ createJobTitleRoutes: () => require('express').Router() }));
vi.mock('../../sessions', () => ({ createSessionRoutes: () => require('express').Router() }));
vi.mock('../../logs', () => ({ createLogRoutes: () => require('express').Router() }));
vi.mock('../../settings', () => ({ createSettingsRoutes: () => require('express').Router() }));
vi.mock('../../pdfTemplates', () => ({ createPdfTemplatesRoutes: () => require('express').Router() }));
vi.mock('../../profile', () => ({ createProfileRoutes: () => require('express').Router() }));
vi.mock('../../dashboard', () => ({ createDashboardRoutes: () => require('express').Router() }));
vi.mock('../../correspondence', () => ({ createCorrespondenceRoutes: () => require('express').Router() }));
vi.mock('../../orgEntities', () => ({ createOrgEntitiesRoutes: () => require('express').Router() }));
vi.mock('../../coi', () => ({ createCoiRoutes: () => require('express').Router() }));
vi.mock('../../policies', () => ({ createPoliciesRoutes: () => require('express').Router() }));
vi.mock('../../appSettings', () => ({ createAppSettingsRoutes: () => require('express').Router() }));
vi.mock('../../executiveReports', () => ({ createExecutiveReportsRoutes: () => require('express').Router() }));
vi.mock('../../departments', () => ({ createDepartmentRoutes: () => require('express').Router() }));
vi.mock('../../analytics', () => ({ createAnalyticsRoutes: () => require('express').Router() }));
vi.mock('../../integrity', () => ({ createIntegrityRoutes: () => require('express').Router() }));
vi.mock('../../auditPrograms', () => ({ createAuditProgramRoutes: () => require('express').Router() }));
vi.mock('../../fraud', () => ({ createFraudRoutes: () => require('express').Router() }));
vi.mock('../../compliance', () => ({ createComplianceRoutes: () => require('express').Router() }));
vi.mock('../../notifications', () => ({ createNotificationRoutes: () => require('express').Router() }));
vi.mock('../../comments', () => ({ createCommentRoutes: () => require('express').Router() }));
vi.mock('../../auditTasks', () => ({ createAuditTaskRoutes: () => require('express').Router() }));
vi.mock('../../recommendations', () => ({ createRecommendationRoutes: () => require('express').Router() }));
vi.mock('../../auditFindings', () => ({ createAuditFindingRoutes: () => require('express').Router() }));
vi.mock('../../bulk', () => ({ createBulkRoutes: () => require('express').Router() }));
vi.mock('../../adminBackup', () => ({ createAdminBackupRoutes: () => require('express').Router() }));
vi.mock('../../permissionAdmin', () => ({ createPermissionAdminRoutes: () => require('express').Router() }));
vi.mock('../../archive', () => ({ createArchiveRoutes: () => require('express').Router() }));
vi.mock('../../lookups', () => ({ createLookupRoutes: () => require('express').Router() }));
vi.mock('../../reports', () => ({ createReportsRoutes: () => require('express').Router() }));
vi.mock('../../webVitals', () => ({ createWebVitalsRoutes: () => require('express').Router() }));
vi.mock('../../health', () => ({
  createHealthRouter: () => {
    const router = require('express').Router();
    router.get('/health', (_req: any, res: any) => res.json({ status: 'healthy' }));
    return router;
  },
}));

import { createV1Router } from '../index';
import { db } from '../../../db/index';

function createTestApp() {
  const app = express();
  app.use(express.json());

  const v1Router = createV1Router({
    db,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { id: 'test-user', role: 'Admin', username: 'test' };
      next();
    },
    authorize: () => (_req: any, _res: any, next: any) => next(),
    checkPermission: () => (_req: any, _res: any, next: any) => next(),
    authLimiter: (_req: any, _res: any, next: any) => next(),
    createNotification: vi.fn(),
    createCrudRoutes: () => require('express').Router(),
    saveFile: vi.fn(),
    logError: vi.fn(),
    config: { jwtSecret: 'jwt-secret', jwtPrivateKey: 'jwt-private', jwtPublicKey: 'jwt-public' } as any,
    idempotencyMiddleware: (_req: any, _res: any, next: any) => next(),
    queueService: null,
    storageService: null,
  });
  app.use('/api/v1', v1Router);

  return app;
}

describe('Docs_Endpoint integration (Task 7.4)', () => {
  let app: express.Application;

  beforeEach(() => {
    app = createTestApp();
  });

  describe('Requirement 10.1: GET /api/v1/docs serves a parseable OpenAPI document', () => {
    it('responds with HTTP 200', async () => {
      const res = await request(app).get('/api/v1/docs');
      expect(res.status).toBe(200);
    });

    it('serves the spec as a YAML/JSON content type', async () => {
      const res = await request(app).get('/api/v1/docs');
      const contentType = res.headers['content-type'] ?? '';
      expect(contentType).toMatch(/yaml|json/i);
    });

    it('returns a non-empty body', async () => {
      const res = await request(app).get('/api/v1/docs');
      expect(res.text.length).toBeGreaterThan(0);
    });

    it('returns a body that parses as a structurally valid OpenAPI document', async () => {
      const res = await request(app).get('/api/v1/docs');

      // The body must be parseable (YAML is a superset of JSON, so this also
      // covers a JSON-serialized spec). A parse error fails the test.
      const parsed = loadYaml(res.text) as Record<string, unknown>;

      expect(parsed).toBeTypeOf('object');
      expect(parsed).not.toBeNull();

      // OpenAPI version field present and well-formed (3.x or swagger 2.x).
      const version = (parsed.openapi ?? parsed.swagger) as string | undefined;
      expect(version, 'document must declare an OpenAPI/Swagger version').toBeTypeOf('string');
      expect(version).toMatch(/^\d+\.\d+/);

      // A `paths` object must be present.
      expect(parsed.paths, 'document must contain a paths object').toBeTypeOf('object');
      expect(parsed.paths).not.toBeNull();
      expect(Object.keys(parsed.paths as Record<string, unknown>).length).toBeGreaterThan(0);
    });
  });
});
