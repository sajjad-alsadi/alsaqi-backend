// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole, ADMIN_ROLES, COMPLIANCE_ROLES } from '@alsaqi/shared';
import { globalErrorHandler } from '../../middleware/error';

/**
 * Integration Tests - Compliance Routes
 *
 * Tests the compliance routes using supertest against a minimal Express app
 * with mocked ComplianceService.
 * Covers CRUD, filtering, status updates, validation, and authorization.
 */

// Mock ComplianceService
const mockComplianceService = {
  getAll: vi.fn().mockResolvedValue([]),
  getSummary: vi.fn().mockResolvedValue({ compliant: 5, partial: 3, non_compliant: 2, under_review: 1 }),
  getById: vi.fn().mockResolvedValue({ id: 'comp-1', title: 'Test Item' }),
  create: vi.fn().mockResolvedValue({ id: 'comp-new', ref_number: 'CMP-001' }),
  update: vi.fn().mockResolvedValue(undefined),
  softDelete: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../services/ComplianceService', () => ({
  ComplianceService: {
    getAll: (...args: any[]) => mockComplianceService.getAll(...args),
    getSummary: (...args: any[]) => mockComplianceService.getSummary(...args),
    getById: (...args: any[]) => mockComplianceService.getById(...args),
    create: (...args: any[]) => mockComplianceService.create(...args),
    update: (...args: any[]) => mockComplianceService.update(...args),
    softDelete: (...args: any[]) => mockComplianceService.softDelete(...args),
  },
}));

import { createComplianceRoutes } from '../compliance';

function createComplianceTestApp(options?: {
  authenticatedRole?: string;
  authenticatedUserId?: string;
}) {
  const authenticatedRole = options?.authenticatedRole || UserRole.ADMIN;
  const authenticatedUserId = options?.authenticatedUserId || 'test-user-id';

  const app = express();
  app.use(express.json());

  const authenticate: express.RequestHandler = (req: any, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = {
      id: authenticatedUserId,
      role: authenticatedRole,
      username: 'testuser',
      name: 'Test User',
      email: 'test@example.com',
    };
    next();
  };

  const authorize = (_module: string, action?: string) => (req: any, res: any, next: any) => {
    // Simple permission check: Admin and Manager can do everything,
    // Compliance Officer can Create/Edit compliance items but not Delete
    const role = req.user?.role;
    if (!role) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    if (['Admin', 'Manager'].includes(role)) {
      return next();
    }
    if (role === 'Compliance Officer' && action && ['Create', 'Edit'].includes(action)) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
  };

  const logError = vi.fn();
  const saveFile = vi.fn().mockResolvedValue('/uploads/mock-file.pdf');

  const router = createComplianceRoutes(null, authenticate, authorize, logError, saveFile);
  app.use('/api/compliance', router);
  app.use(globalErrorHandler);

  return { app, saveFile };
}

describe('Compliance Integration Tests', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    const testApp = createComplianceTestApp();
    app = testApp.app;
  });

  // ─── GET /api/compliance ─────────────────────────────────────────────────

  describe('GET /api/compliance', () => {
    it('should return 200 with compliance items list', async () => {
      mockComplianceService.getAll.mockResolvedValueOnce([
        { id: 'comp-1', title: 'CBI Instruction 1' },
      ]);

      const res = await request(app)
        .get('/api/compliance')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(mockComplianceService.getAll).toHaveBeenCalled();
    });

    it('should pass source_type filter to service', async () => {
      const res = await request(app)
        .get('/api/compliance?source_type=law')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(mockComplianceService.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ source_type: 'law' })
      );
    });

    it('should pass compliance_status filter to service', async () => {
      const res = await request(app)
        .get('/api/compliance?compliance_status=compliant')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(mockComplianceService.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ compliance_status: 'compliant' })
      );
    });

    it('should pass search filter to service', async () => {
      const res = await request(app)
        .get('/api/compliance?search=instruction')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(mockComplianceService.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'instruction' })
      );
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/compliance');
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/compliance/summary ─────────────────────────────────────────

  describe('GET /api/compliance/summary', () => {
    it('should return 200 with summary statistics', async () => {
      const res = await request(app)
        .get('/api/compliance/summary')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ compliant: 5, partial: 3, non_compliant: 2, under_review: 1 });
      expect(mockComplianceService.getSummary).toHaveBeenCalled();
    });
  });

  // ─── GET /api/compliance/:id ─────────────────────────────────────────────

  describe('GET /api/compliance/:id', () => {
    it('should return 200 with compliance item by ID', async () => {
      const res = await request(app)
        .get('/api/compliance/comp-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('comp-1');
      expect(mockComplianceService.getById).toHaveBeenCalledWith('comp-1');
    });
  });

  // ─── POST /api/compliance ────────────────────────────────────────────────

  describe('POST /api/compliance', () => {
    const validItem = {
      ref_number: 'CMP-001',
      title: 'تعليمات البنك المركزي',
      source_type: 'cbi_instruction',
    };

    it('should return 201 on valid creation by Admin', async () => {
      const res = await request(app)
        .post('/api/compliance')
        .set('Authorization', 'Bearer valid-token')
        .send(validItem);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockComplianceService.create).toHaveBeenCalledWith(
        expect.objectContaining({ ref_number: 'CMP-001' }),
        'test-user-id'
      );
    });

    it('should allow Compliance Officer (part of COMPLIANCE_ROLES)', async () => {
      const { app: compApp } = createComplianceTestApp({
        authenticatedRole: UserRole.COMPLIANCE_OFFICER,
      });

      const res = await request(compApp)
        .post('/api/compliance')
        .set('Authorization', 'Bearer valid-token')
        .send(validItem);

      expect(res.status).toBe(201);
    });

    it('should reject when ref_number is empty', async () => {
      const res = await request(app)
        .post('/api/compliance')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validItem, ref_number: '' });

      expect(res.status).toBe(400);
    });

    it('should reject when title exceeds 500 characters', async () => {
      const res = await request(app)
        .post('/api/compliance')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validItem, title: 'x'.repeat(501) });

      expect(res.status).toBe(400);
    });

    it('should reject invalid source_type enum value', async () => {
      const res = await request(app)
        .post('/api/compliance')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validItem, source_type: 'invalid_type' });

      expect(res.status).toBe(400);
    });

    it('should return 403 for roles not in COMPLIANCE_ROLES or ADMIN_ROLES', async () => {
      const { app: riskApp } = createComplianceTestApp({
        authenticatedRole: UserRole.RISK_OFFICER,
      });

      const res = await request(riskApp)
        .post('/api/compliance')
        .set('Authorization', 'Bearer valid-token')
        .send(validItem);

      expect(res.status).toBe(403);
    });
  });

  // ─── PUT /api/compliance/:id ─────────────────────────────────────────────

  describe('PUT /api/compliance/:id', () => {
    it('should return 200 on valid update by Admin', async () => {
      const res = await request(app)
        .put('/api/compliance/comp-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ title: 'Updated Title' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockComplianceService.update).toHaveBeenCalledWith('comp-1', expect.objectContaining({ title: 'Updated Title' }));
    });

    it('should allow Manager role (part of COMPLIANCE_ROLES)', async () => {
      const { app: managerApp } = createComplianceTestApp({
        authenticatedRole: UserRole.MANAGER,
      });

      const res = await request(managerApp)
        .put('/api/compliance/comp-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ title: 'Manager Update' });

      expect(res.status).toBe(200);
    });

    it('should return 403 for Viewer role', async () => {
      const { app: viewerApp } = createComplianceTestApp({
        authenticatedRole: UserRole.VIEWER,
      });

      const res = await request(viewerApp)
        .put('/api/compliance/comp-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ title: 'Attempt' });

      expect(res.status).toBe(403);
    });
  });

  // ─── PATCH /api/compliance/:id/status ────────────────────────────────────

  describe('PATCH /api/compliance/:id/status', () => {
    it('should return 200 for valid status "compliant"', async () => {
      const res = await request(app)
        .patch('/api/compliance/comp-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ compliance_status: 'compliant' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockComplianceService.update).toHaveBeenCalledWith('comp-1', { compliance_status: 'compliant' });
    });

    it('should return 200 for valid status "non_compliant"', async () => {
      const res = await request(app)
        .patch('/api/compliance/comp-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ compliance_status: 'non_compliant' });

      expect(res.status).toBe(200);
    });

    it('should reject invalid status value', async () => {
      const res = await request(app)
        .patch('/api/compliance/comp-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ compliance_status: 'invalid_status' });

      expect(res.status).toBe(400);
    });

    it('should return 403 for Internal Auditor (not in COMPLIANCE_ROLES)', async () => {
      const { app: auditorApp } = createComplianceTestApp({
        authenticatedRole: UserRole.INTERNAL_AUDITOR,
      });

      const res = await request(auditorApp)
        .patch('/api/compliance/comp-1/status')
        .set('Authorization', 'Bearer valid-token')
        .send({ compliance_status: 'compliant' });

      expect(res.status).toBe(403);
    });
  });

  // ─── DELETE /api/compliance/:id ──────────────────────────────────────────

  describe('DELETE /api/compliance/:id', () => {
    it('should return 200 on successful deletion by Admin', async () => {
      const res = await request(app)
        .delete('/api/compliance/comp-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockComplianceService.softDelete).toHaveBeenCalledWith('comp-1');
    });

    it('should return 403 for Compliance Officer (DELETE requires ADMIN_ROLES only)', async () => {
      const { app: compApp } = createComplianceTestApp({
        authenticatedRole: UserRole.COMPLIANCE_OFFICER,
      });

      const res = await request(compApp)
        .delete('/api/compliance/comp-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
    });

    it('should return 403 for Internal Auditor on DELETE', async () => {
      const { app: auditorApp } = createComplianceTestApp({
        authenticatedRole: UserRole.INTERNAL_AUDITOR,
      });

      const res = await request(auditorApp)
        .delete('/api/compliance/comp-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
    });

    it('should allow Manager role (part of ADMIN_ROLES) to delete', async () => {
      const { app: managerApp } = createComplianceTestApp({
        authenticatedRole: UserRole.MANAGER,
      });

      const res = await request(managerApp)
        .delete('/api/compliance/comp-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
    });
  });
});
