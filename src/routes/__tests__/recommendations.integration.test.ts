// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { globalErrorHandler } from '../../middleware/error';

/**
 * Integration Tests - Recommendations Routes
 *
 * Tests the recommendations resolve route using supertest against a minimal Express app.
 * Covers status update with evidence, validation, and authentication.
 */

import { createRecommendationRoutes } from '../recommendations';

function createRecommendationTestApp(options?: {
  authenticatedRole?: string;
  authenticatedUserId?: string;
}) {
  const authenticatedRole = options?.authenticatedRole || 'Admin';
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

  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ changes: 1 }),
    }),
  };

  const logError = vi.fn();

  const router = createRecommendationRoutes(mockDb, authenticate, logError);
  app.use('/api/recommendations', router);
  app.use(globalErrorHandler);

  return { app, mockDb, logError };
}

describe('Recommendations Integration Tests', () => {
  let app: express.Application;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    const testApp = createRecommendationTestApp();
    app = testApp.app;
    mockDb = testApp.mockDb;
  });

  // ─── POST /api/recommendations - BLOCKED ────────────────────────────────────

  describe('POST /api/recommendations (blocked)', () => {
    it('should return 403 ForbiddenError when attempting to create a recommendation manually', async () => {
      const res = await request(app)
        .post('/api/recommendations')
        .set('Authorization', 'Bearer valid-token')
        .send({
          finding_id: 'some-finding-id',
          department: 'IT',
          responsible: 'John',
          due_date: '2025-12-31',
          status: 'Open',
          risk_level: 'High',
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain('automatically derived');
    });

    it('should return 401 when not authenticated for POST', async () => {
      const res = await request(app)
        .post('/api/recommendations')
        .send({ finding_id: 'some-id' });

      expect(res.status).toBe(401);
    });
  });

  // ─── PATCH /api/recommendations/:id/resolve ────────────────────────────────

  describe('PATCH /api/recommendations/:id/resolve', () => {
    it('should return 200 and update status to closed when closure_evidence_path is provided', async () => {
      const res = await request(app)
        .patch('/api/recommendations/rec-1/resolve')
        .set('Authorization', 'Bearer valid-token')
        .send({ closure_evidence_path: '/uploads/evidence.pdf' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDb.prepare).toHaveBeenCalled();
      // Verify the SQL updates status to 'closed'
      const prepareCall = mockDb.prepare.mock.calls[0][0];
      expect(prepareCall).toContain("status = 'closed'");
      expect(prepareCall).toContain('closure_evidence_path');
    });

    it('should pass correct parameters to the database update', async () => {
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue([]),
        run: mockRun,
      });

      await request(app)
        .patch('/api/recommendations/rec-1/resolve')
        .set('Authorization', 'Bearer valid-token')
        .send({ closure_evidence_path: '/uploads/evidence.pdf' });

      expect(mockRun).toHaveBeenCalledWith(
        '/uploads/evidence.pdf',
        'test-user-id',
        'rec-1'
      );
    });

    it('should return 400 when closure_evidence_path is missing', async () => {
      const res = await request(app)
        .patch('/api/recommendations/rec-1/resolve')
        .set('Authorization', 'Bearer valid-token')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain('Evidence path is mandatory');
    });

    it('should return 400 when closure_evidence_path is empty string', async () => {
      const res = await request(app)
        .patch('/api/recommendations/rec-1/resolve')
        .set('Authorization', 'Bearer valid-token')
        .send({ closure_evidence_path: '' });

      expect(res.status).toBe(400);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .patch('/api/recommendations/rec-1/resolve')
        .send({ closure_evidence_path: '/uploads/evidence.pdf' });

      expect(res.status).toBe(401);
    });
  });
});
