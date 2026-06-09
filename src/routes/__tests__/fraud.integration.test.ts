// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole, ADMIN_ROLES } from '@alsaqi/shared';
import { globalErrorHandler } from '../../middleware/error';

/**
 * Integration Tests - Fraud Access Request Routes
 *
 * Tests the fraud access request routes using supertest against a minimal Express app
 * with mocked FraudService and AuthService.
 * Covers create, approve, reject, list, my-status, and authorization.
 */

// Mock FraudService
const mockFraudService = {
  createRequest: vi.fn().mockResolvedValue(1),
  getRequests: vi.fn().mockResolvedValue([]),
  getMyStatus: vi.fn().mockResolvedValue({ status: 'None' }),
  approveRequest: vi.fn().mockResolvedValue({ user_id: 'requester-user-id' }),
  rejectRequest: vi.fn().mockResolvedValue({ user_id: 'requester-user-id' }),
};

vi.mock('../../services/FraudService', () => ({
  FraudService: {
    createRequest: (...args: any[]) => mockFraudService.createRequest(...args),
    getRequests: (...args: any[]) => mockFraudService.getRequests(...args),
    getMyStatus: (...args: any[]) => mockFraudService.getMyStatus(...args),
    approveRequest: (...args: any[]) => mockFraudService.approveRequest(...args),
    rejectRequest: (...args: any[]) => mockFraudService.rejectRequest(...args),
  },
}));

// Mock AuthService
vi.mock('../../services/AuthService', () => ({
  AuthService: {
    logAudit: vi.fn().mockResolvedValue(undefined),
  },
}));

import { createFraudRoutes } from '../fraud';

function createFraudTestApp(options?: {
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

  const authorize = (_module: string, _action?: string) => (req: any, res: any, next: any) => {
    const role = req.user?.role;
    if (!role) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    const adminRoles = ['Admin', 'Manager'];
    if (adminRoles.includes(role)) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
  };

  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]),
      run: vi.fn().mockResolvedValue({ changes: 1 }),
    }),
  };

  const logError = vi.fn();
  const createNotification = vi.fn().mockResolvedValue(undefined);

  const router = createFraudRoutes(mockDb, authenticate, authorize, logError, createNotification);
  app.use('/api/fraud-access-requests', router);
  app.use(globalErrorHandler);

  return { app, mockDb, logError, createNotification };
}

describe('Fraud Access Requests Integration Tests', () => {
  let app: express.Application;
  let createNotification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const testApp = createFraudTestApp();
    app = testApp.app;
    createNotification = testApp.createNotification;
  });

  // ─── POST /api/fraud-access-requests ─────────────────────────────────────

  describe('POST /api/fraud-access-requests', () => {
    it('should create a request and notify admins', async () => {
      const res = await request(app)
        .post('/api/fraud-access-requests')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'Need access for investigation' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBe(1);
      expect(mockFraudService.createRequest).toHaveBeenCalledWith(
        'test-user-id',
        'testuser',
        'Need access for investigation'
      );
      // Should notify admins
      expect(createNotification).toHaveBeenCalled();
    });

    it('should return 400 when reason is too short', async () => {
      const res = await request(app)
        .post('/api/fraud-access-requests')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'ab' });

      expect(res.status).toBe(400);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/api/fraud-access-requests')
        .send({ reason: 'Need access for investigation' });

      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/fraud-access-requests ──────────────────────────────────────

  describe('GET /api/fraud-access-requests', () => {
    it('should return list of requests for admin', async () => {
      mockFraudService.getRequests.mockResolvedValueOnce([
        { id: 'req-1', user_name: 'user1', status: 'Pending' },
      ]);

      const res = await request(app)
        .get('/api/fraud-access-requests')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(mockFraudService.getRequests).toHaveBeenCalled();
    });
  });

  // ─── GET /api/fraud-access-requests/my-status ────────────────────────────

  describe('GET /api/fraud-access-requests/my-status', () => {
    it('should return current user request status', async () => {
      mockFraudService.getMyStatus.mockResolvedValueOnce({ status: 'Approved', expires_at: '2025-12-31' });

      const res = await request(app)
        .get('/api/fraud-access-requests/my-status')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Approved');
      expect(mockFraudService.getMyStatus).toHaveBeenCalledWith('test-user-id');
    });

    it('should return "None" status when no request exists', async () => {
      const res = await request(app)
        .get('/api/fraud-access-requests/my-status')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('None');
    });
  });

  // ─── PUT /api/fraud-access-requests/:id/approve ──────────────────────────

  describe('PUT /api/fraud-access-requests/:id/approve', () => {
    it('should approve request and notify requester', async () => {
      const res = await request(app)
        .put('/api/fraud-access-requests/req-1/approve')
        .set('Authorization', 'Bearer valid-token')
        .send({ duration: 30 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockFraudService.approveRequest).toHaveBeenCalledWith('req-1', 30, 'test-user-id');
      // Should notify the requester
      expect(createNotification).toHaveBeenCalledWith(
        'requester-user-id',
        'access_approved',
        expect.any(String),
        'Fraud Log',
        '/fraud-log',
        expect.objectContaining({ actorId: 'test-user-id' })
      );
    });

    it('should return 403 for non-admin roles', async () => {
      const { app: viewerApp } = createFraudTestApp({
        authenticatedRole: UserRole.VIEWER,
      });

      const res = await request(viewerApp)
        .put('/api/fraud-access-requests/req-1/approve')
        .set('Authorization', 'Bearer valid-token')
        .send({ duration: 30 });

      expect(res.status).toBe(403);
    });
  });

  // ─── PUT /api/fraud-access-requests/:id/reject ───────────────────────────

  describe('PUT /api/fraud-access-requests/:id/reject', () => {
    it('should reject request with reason and notify requester', async () => {
      const res = await request(app)
        .put('/api/fraud-access-requests/req-1/reject')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'Insufficient justification provided' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockFraudService.rejectRequest).toHaveBeenCalledWith('req-1', 'Insufficient justification provided', 'test-user-id');
      // Should notify the requester
      expect(createNotification).toHaveBeenCalledWith(
        'requester-user-id',
        'access_rejected',
        expect.stringContaining('rejected'),
        'Fraud Log',
        '/fraud-log',
        expect.objectContaining({ actorId: 'test-user-id' })
      );
    });

    it('should return 403 for non-admin roles (Internal Auditor)', async () => {
      const { app: auditorApp } = createFraudTestApp({
        authenticatedRole: UserRole.INTERNAL_AUDITOR,
      });

      const res = await request(auditorApp)
        .put('/api/fraud-access-requests/req-1/reject')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'Not allowed to reject' });

      expect(res.status).toBe(403);
    });

    it('should return 400 when rejection reason is too short', async () => {
      const res = await request(app)
        .put('/api/fraud-access-requests/req-1/reject')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'no' });

      expect(res.status).toBe(400);
    });
  });
});
