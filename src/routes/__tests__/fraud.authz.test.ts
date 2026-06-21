// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@alsaqi/shared';
import { globalErrorHandler } from '../../middleware/error';

/**
 * Authorization Tests - Fraud Access Request Routes (Task 5.4)
 *
 * Verifies that the state-changing fraud routes enforce permission checks that
 * mirror the real `checkPermission(module, action)` semantics from
 * `src/middleware/auth.ts`:
 *   - `req.user` must be populated (otherwise 401)
 *   - the `Admin` role bypasses the permission check without a lookup
 *   - a non-Admin user is allowed only when they hold the `module:action` permission
 *   - denial returns a structured HTTP 403 with `code: 'PERMISSION_DENIED'`
 *     and the offending `module`/`action`, and the protected handler never runs
 *
 * Covers the POST '/' (IntegrityManagement:Create) and the PUT approve/reject
 * routes (IntegrityManagement:Approve).
 *
 * _Requirements: 6.2, 6.3_
 */

// ─── Service mocks so the protected handlers can run when authorized ──────────
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

vi.mock('../../services/AuthService', () => ({
  AuthService: {
    logAudit: vi.fn().mockResolvedValue(undefined),
  },
}));

import { createFraudRoutes } from '../fraud';

/**
 * A permission is encoded as the `${module}:${action}` string used by the
 * fraud routes (e.g. 'IntegrityManagement:Create', 'IntegrityManagement:Approve').
 */
type PermissionKey = string;

interface AuthzAppOptions {
  /** Role assigned to the authenticated user. Defaults to a non-admin role. */
  role?: string;
  /** Permission keys the authenticated user holds. Defaults to none. */
  permissions?: PermissionKey[];
  /** When false, `authenticate` does not populate req.user (simulates anonymous). */
  authenticated?: boolean;
}

/**
 * Build a minimal Express app mounting the fraud routes with:
 *  - an `authenticate` stub that populates `req.user` from the test options
 *  - a `checkPermission(module, action)` factory stub that mirrors the real
 *    middleware in `src/middleware/auth.ts`: 401 if unauthenticated, Admin
 *    bypass, permission-set lookup otherwise, structured 403 on denial.
 */
function createAuthzTestApp(options: AuthzAppOptions = {}) {
  const role = options.role ?? UserRole.INTERNAL_AUDITOR;
  const permissions = new Set(options.permissions ?? []);
  const authenticated = options.authenticated ?? true;

  const app = express();
  app.use(express.json());

  const authenticate: express.RequestHandler = (req: any, _res, next) => {
    if (authenticated) {
      req.user = {
        id: 'test-user-id',
        role,
        username: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
      };
    }
    next();
  };

  // Mirrors checkPermission(module, action) from src/middleware/auth.ts.
  const checkPermission =
    (module: string, action: string): express.RequestHandler =>
    (req: any, res, next) => {
      // Req: authenticate() must have populated req.user.
      if (!req.user) {
        return res.status(401).json({
          error: 'Authentication required. Please authenticate before accessing this resource.',
        });
      }

      // Admin bypass — full access without a permission lookup.
      if (req.user.role === UserRole.ADMIN) {
        return next();
      }

      // Permission-set lookup for non-Admin users.
      if (permissions.has(`${module}:${action}`)) {
        return next();
      }

      // Structured 403 denial (Req 6.3).
      return res.status(403).json({
        error: `Forbidden: Missing permission '${action}' on module '${module}'`,
        code: 'PERMISSION_DENIED',
        module,
        action,
      });
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

  const router = createFraudRoutes(mockDb, authenticate, checkPermission, logError, createNotification);
  app.use('/api/fraud-access-requests', router);
  app.use(globalErrorHandler);

  return { app };
}

describe('Fraud Routes - Authorization (Task 5.4, Req 6.2/6.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST '/' requires IntegrityManagement:Create ──────────────────────────
  describe("POST '/' (IntegrityManagement:Create)", () => {
    it('returns 403 PERMISSION_DENIED for an authenticated non-Admin lacking the permission, and does not run the handler', async () => {
      const { app } = createAuthzTestApp({
        role: UserRole.INTERNAL_AUDITOR,
        permissions: [], // no IntegrityManagement:Create
      });

      const res = await request(app)
        .post('/api/fraud-access-requests')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'Need access for investigation' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(res.body.module).toBe('IntegrityManagement');
      expect(res.body.action).toBe('Create');
      // Protected action must not execute (Req 6.3).
      expect(mockFraudService.createRequest).not.toHaveBeenCalled();
    });

    it('allows a non-Admin user WITH the permission to proceed', async () => {
      const { app } = createAuthzTestApp({
        role: UserRole.INTERNAL_AUDITOR,
        permissions: ['IntegrityManagement:Create'],
      });

      const res = await request(app)
        .post('/api/fraud-access-requests')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'Need access for investigation' });

      // Not rejected on authorization grounds and handler executed (Req 6.2).
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(mockFraudService.createRequest).toHaveBeenCalledTimes(1);
    });

    it('allows an Admin to proceed without holding the explicit permission', async () => {
      const { app } = createAuthzTestApp({
        role: UserRole.ADMIN,
        permissions: [],
      });

      const res = await request(app)
        .post('/api/fraud-access-requests')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'Need access for investigation' });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(mockFraudService.createRequest).toHaveBeenCalledTimes(1);
    });
  });

  // ─── PUT '/:id/approve' requires IntegrityManagement:Approve ───────────────
  describe("PUT '/:id/approve' (IntegrityManagement:Approve)", () => {
    it('returns 403 PERMISSION_DENIED for an authenticated non-Admin lacking the permission, and does not run the handler', async () => {
      const { app } = createAuthzTestApp({
        role: UserRole.VIEWER,
        permissions: [],
      });

      const res = await request(app)
        .put('/api/fraud-access-requests/req-1/approve')
        .set('Authorization', 'Bearer valid-token')
        .send({ duration: 30 });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(res.body.module).toBe('IntegrityManagement');
      expect(res.body.action).toBe('Approve');
      expect(mockFraudService.approveRequest).not.toHaveBeenCalled();
    });

    it('allows a non-Admin user WITH the permission to proceed', async () => {
      const { app } = createAuthzTestApp({
        role: UserRole.MANAGER,
        permissions: ['IntegrityManagement:Approve'],
      });

      const res = await request(app)
        .put('/api/fraud-access-requests/req-1/approve')
        .set('Authorization', 'Bearer valid-token')
        .send({ duration: 30 });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(mockFraudService.approveRequest).toHaveBeenCalledWith('req-1', 30, 'test-user-id');
    });

    it('allows an Admin to proceed without holding the explicit permission', async () => {
      const { app } = createAuthzTestApp({ role: UserRole.ADMIN, permissions: [] });

      const res = await request(app)
        .put('/api/fraud-access-requests/req-1/approve')
        .set('Authorization', 'Bearer valid-token')
        .send({ duration: 30 });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(mockFraudService.approveRequest).toHaveBeenCalledTimes(1);
    });
  });

  // ─── PUT '/:id/reject' requires IntegrityManagement:Approve ────────────────
  describe("PUT '/:id/reject' (IntegrityManagement:Approve)", () => {
    it('returns 403 PERMISSION_DENIED for an authenticated non-Admin lacking the permission, and does not run the handler', async () => {
      const { app } = createAuthzTestApp({
        role: UserRole.INTERNAL_AUDITOR,
        permissions: [],
      });

      const res = await request(app)
        .put('/api/fraud-access-requests/req-1/reject')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'Insufficient justification provided' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(res.body.module).toBe('IntegrityManagement');
      expect(res.body.action).toBe('Approve');
      expect(mockFraudService.rejectRequest).not.toHaveBeenCalled();
    });

    it('allows a non-Admin user WITH the permission to proceed', async () => {
      const { app } = createAuthzTestApp({
        role: UserRole.MANAGER,
        permissions: ['IntegrityManagement:Approve'],
      });

      const res = await request(app)
        .put('/api/fraud-access-requests/req-1/reject')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'Insufficient justification provided' });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(mockFraudService.rejectRequest).toHaveBeenCalledWith(
        'req-1',
        'Insufficient justification provided',
        'test-user-id'
      );
    });

    it('allows an Admin to proceed without holding the explicit permission', async () => {
      const { app } = createAuthzTestApp({ role: UserRole.ADMIN, permissions: [] });

      const res = await request(app)
        .put('/api/fraud-access-requests/req-1/reject')
        .set('Authorization', 'Bearer valid-token')
        .send({ reason: 'Insufficient justification provided' });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(mockFraudService.rejectRequest).toHaveBeenCalledTimes(1);
    });
  });
});
