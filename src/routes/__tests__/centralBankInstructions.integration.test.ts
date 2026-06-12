// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Integration Tests - central-bank-instructions via the live v1 router (FIX-BE-3)
 *
 * After the orphaned `src/routes/regulatory.ts` (which returned 501 for
 * POST /central-bank-instructions) was deleted, the `central_bank_instructions`
 * entity is served end-to-end by the CRUD generator
 * (`generateRoutes("central_bank_instructions", "central-bank-instructions", "Policies")`),
 * mounted in `createV1Router`.
 *
 * These tests drive GET and POST `/central-bank-instructions` through the real
 * `createV1Router` (with the real `createCrudRoutes`) and assert that the
 * response is NOT 501 and is wrapped in the unified API_Envelope
 * (`{ success, data, meta }`) with `success: true` on the success path.
 *
 * Validates: Requirements 3.1
 */

// ─── Service mocks (DB-touching collaborators of the CRUD generator) ─────────

const mockBaseService = {
  findAll: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const mockAuthService = {
  logAudit: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../services/BaseService', () => ({
  BaseService: {
    findAll: (...args: any[]) => mockBaseService.findAll(...args),
    findById: (...args: any[]) => mockBaseService.findById(...args),
    create: (...args: any[]) => mockBaseService.create(...args),
    update: (...args: any[]) => mockBaseService.update(...args),
    delete: (...args: any[]) => mockBaseService.delete(...args),
  },
}));

vi.mock('../../services/AuthService', () => ({
  AuthService: {
    logAudit: (...args: any[]) => mockAuthService.logAudit(...args),
  },
}));

vi.mock('../../services/AuditPlanService', () => ({
  AuditPlanService: { create: vi.fn(), update: vi.fn() },
}));

vi.mock('../../services/RiskService', () => ({
  RiskService: { create: vi.fn(), update: vi.fn() },
}));

vi.mock('../../services/NotificationService', () => ({
  NotificationService: {
    create: vi.fn(),
    getUserIdByName: vi.fn().mockResolvedValue('owner-user-id'),
    getAdminIds: vi.fn().mockResolvedValue(['admin-1']),
  },
}));

vi.mock('../../db/index', () => ({
  db: {
    isExternal: false,
    client: { dataDir: '/tmp/test' },
    prepare: vi.fn(() => ({
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue(undefined),
    })),
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

// Mock the other route factory modules imported by v1/index.ts so the test
// stays isolated to the CRUD path (mirrors apiVersioning.test.ts). The CRUD
// generator itself is NOT mocked — the real one is injected via deps.
vi.mock('../auth', () => ({ createAuthRoutes: () => require('express').Router() }));
vi.mock('../users', () => ({ createUserRoutes: () => require('express').Router() }));
vi.mock('../roles', () => ({ createRoleRoutes: () => require('express').Router() }));
vi.mock('../jobTitles', () => ({ createJobTitleRoutes: () => require('express').Router() }));
vi.mock('../sessions', () => ({ createSessionRoutes: () => require('express').Router() }));
vi.mock('../logs', () => ({ createLogRoutes: () => require('express').Router() }));
vi.mock('../settings', () => ({ createSettingsRoutes: () => require('express').Router() }));
vi.mock('../pdfTemplates', () => ({ createPdfTemplatesRoutes: () => require('express').Router() }));
vi.mock('../profile', () => ({ createProfileRoutes: () => require('express').Router() }));
vi.mock('../dashboard', () => ({ createDashboardRoutes: () => require('express').Router() }));
vi.mock('../correspondence', () => ({ createCorrespondenceRoutes: () => require('express').Router() }));
vi.mock('../orgEntities', () => ({ createOrgEntitiesRoutes: () => require('express').Router() }));
vi.mock('../coi', () => ({ createCoiRoutes: () => require('express').Router() }));
vi.mock('../policies', () => ({ createPoliciesRoutes: () => require('express').Router() }));
vi.mock('../appSettings', () => ({ createAppSettingsRoutes: () => require('express').Router() }));
vi.mock('../executiveReports', () => ({ createExecutiveReportsRoutes: () => require('express').Router() }));
vi.mock('../departments', () => ({ createDepartmentRoutes: () => require('express').Router() }));
vi.mock('../analytics', () => ({ createAnalyticsRoutes: () => require('express').Router() }));
vi.mock('../integrity', () => ({ createIntegrityRoutes: () => require('express').Router() }));
vi.mock('../auditPrograms', () => ({ createAuditProgramRoutes: () => require('express').Router() }));
vi.mock('../fraud', () => ({ createFraudRoutes: () => require('express').Router() }));
vi.mock('../compliance', () => ({ createComplianceRoutes: () => require('express').Router() }));
vi.mock('../notifications', () => ({ createNotificationRoutes: () => require('express').Router() }));
vi.mock('../comments', () => ({ createCommentRoutes: () => require('express').Router() }));
vi.mock('../auditTasks', () => ({ createAuditTaskRoutes: () => require('express').Router() }));
vi.mock('../recommendations', () => ({ createRecommendationRoutes: () => require('express').Router() }));
vi.mock('../auditFindings', () => ({ createAuditFindingRoutes: () => require('express').Router() }));
vi.mock('../health', () => ({ createHealthRouter: () => require('express').Router() }));
vi.mock('../bulk', () => ({ createBulkRoutes: () => require('express').Router() }));
vi.mock('../adminBackup', () => ({ createAdminBackupRoutes: () => require('express').Router() }));
vi.mock('../permissionAdmin', () => ({ createPermissionAdminRoutes: () => require('express').Router() }));
vi.mock('../archive', () => ({ createArchiveRoutes: () => require('express').Router() }));
vi.mock('../lookups', () => ({ createLookupRoutes: () => require('express').Router() }));
vi.mock('../reports', () => ({ createReportsRoutes: () => require('express').Router() }));

import { createV1Router } from '../v1/index';
import { createCrudRoutes } from '../../utils/crudGenerator';
import { createResponseWrapper } from '../../middleware/responseWrapper';
import { apiVersionMiddleware } from '../../middleware/apiVersion';

/**
 * Builds a test app from the live `createV1Router`, injecting the REAL
 * `createCrudRoutes` (so `central-bank-instructions` is served by the CRUD
 * generator), and applying the real response-envelope + version-header
 * middleware so the unified API_Envelope is produced exactly as in production.
 */
function createTestApp() {
  const app = express();
  app.use(express.json());

  // Unified API_Envelope + version header (applied centrally in production)
  app.use(apiVersionMiddleware);
  app.use(createResponseWrapper());

  const v1Router = createV1Router({
    db: {},
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { id: 'test-user', role: 'Admin', username: 'testuser' };
      next();
    },
    authorize: () => (_req: any, _res: any, next: any) => next(),
    checkPermission: () => (_req: any, _res: any, next: any) => next(),
    authLimiter: (_req: any, _res: any, next: any) => next(),
    createNotification: vi.fn().mockResolvedValue(undefined),
    createCrudRoutes, // real CRUD generator
    saveFile: vi.fn().mockResolvedValue('/uploads/mock.pdf'),
    logError: vi.fn(),
    config: { jwtSecret: 'jwt-secret', jwtPrivateKey: 'jwt-private', jwtPublicKey: 'jwt-public' } as any,
    idempotencyMiddleware: (_req: any, _res: any, next: any) => next(),
    queueService: null,
    storageService: null,
  });

  app.use('/api/v1', v1Router);
  return app;
}

describe('central-bank-instructions via live v1 router (FIX-BE-3)', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  describe('GET /api/v1/central-bank-instructions', () => {
    it('returns a non-501 success response wrapped in the API_Envelope', async () => {
      mockBaseService.findAll.mockResolvedValue({
        data: [
          { id: 'cbi-1', title: 'تعليمات البنك المركزي', reference_number: 'CBI-24-001', status: 'Active' },
        ],
        pagination: { page: 1, pageSize: 50, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
      });

      const res = await request(app)
        .get('/api/v1/central-bank-instructions')
        .set('Authorization', 'Bearer test-token');

      // Must NOT be the old 501 Not Implemented from the orphaned regulatory route
      expect(res.status).not.toBe(501);
      expect(res.status).toBe(200);

      // Unified API_Envelope: { success, data, meta }
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.meta).toHaveProperty('version');

      // The CRUD generator served the list via BaseService.findAll
      expect(mockBaseService.findAll).toHaveBeenCalledWith(
        'central_bank_instructions',
        expect.objectContaining({ select: expect.arrayContaining(['id', 'title', 'reference_number']) })
      );

      // X-API-Version header preserved
      expect(res.headers['x-api-version']).toBeDefined();
    });
  });

  describe('POST /api/v1/central-bank-instructions', () => {
    it('returns a non-501 success response wrapped in the API_Envelope', async () => {
      mockBaseService.create.mockResolvedValue({
        id: 'cbi-new-1',
        title: 'تعليمات جديدة',
        reference_number: 'CBI-24-002',
        category: 'Policies',
        status: 'Active',
      });

      const res = await request(app)
        .post('/api/v1/central-bank-instructions')
        .set('Authorization', 'Bearer test-token')
        .send({
          title: 'تعليمات جديدة',
          issue_date: '2024-05-01',
          reference_number: 'CBI-24-002',
          category: 'Policies',
          description: 'وصف التعليمات',
          related_department: 'Compliance',
          status: 'Active',
        });

      // Must NOT be the old 501 Not Implemented from the orphaned regulatory route
      expect(res.status).not.toBe(501);
      expect(res.status).toBe(200);

      // Unified API_Envelope: { success, data, meta }
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('data');
      expect(res.body.data).toMatchObject({ id: 'cbi-new-1', reference_number: 'CBI-24-002' });
      expect(res.body).toHaveProperty('meta');

      // The CRUD generator persisted via BaseService.create with whitelisted fields
      expect(mockBaseService.create).toHaveBeenCalledWith(
        'central_bank_instructions',
        expect.objectContaining({ title: 'تعليمات جديدة', reference_number: 'CBI-24-002' })
      );
    });
  });
});
