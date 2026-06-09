// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createReportsRoutes } from '../reports.js';

/**
 * Unit Tests - Report Generation API Endpoint and Status Tracking (Task 7.2)
 *
 * Tests:
 * - POST /reports/generate: creates record, queues job, responds 202
 * - GET /reports/:reportId/status: returns status, downloadUrl, errorMessage
 * - 5-minute timeout: marks stale pending reports as failed
 *
 * Validates: Requirements 5.7, 8.1, 8.4, 8.5, 8.6
 */

function createTestApp(options?: {
  queueService?: any;
  storageService?: any;
}) {
  const app = express();
  app.use(express.json());

  const authenticate: express.RequestHandler = (req: any, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = { id: 'test-user-id', username: 'testuser', role: 'Admin' };
    next();
  };

  const checkPermission = () => (_req: any, _res: any, next: any) => next();
  const logError = vi.fn();

  const mockDb = createMockDb();
  (app as any)._mockDb = mockDb;

  const router = createReportsRoutes(
    mockDb,
    authenticate,
    checkPermission,
    logError,
    options?.queueService ?? null,
    options?.storageService ?? null,
  );
  app.use('/reports', router);

  // Error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message, details: err.details });
  });

  return app;
}

function createMockDb() {
  const mockGet = vi.fn().mockResolvedValue(null);
  const mockAll = vi.fn().mockResolvedValue([]);
  const mockRun = vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 });

  const prepare = vi.fn().mockReturnValue({
    get: mockGet,
    all: mockAll,
    run: mockRun,
  });

  return { prepare, mockGet, mockAll, mockRun };
}

function authGet(app: express.Application, url: string) {
  return request(app).get(url).set('Authorization', 'Bearer test-token');
}

function authPost(app: express.Application, url: string) {
  return request(app).post(url).set('Authorization', 'Bearer test-token');
}

describe('Report Generation Routes (Task 7.2)', () => {
  describe('POST /reports/generate', () => {
    it('should return 202 with reportId when valid auditId is provided (Req 5.7, 8.1)', async () => {
      const app = createTestApp();

      const response = await authPost(app, '/reports/generate')
        .send({ auditId: 'audit-456' });

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty('reportId');
      expect(response.body.reportId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('should create a report record in the database with pending status', async () => {
      const app = createTestApp();
      const mockDb = (app as any)._mockDb;

      await authPost(app, '/reports/generate')
        .send({ auditId: 'audit-456', templateTypeKey: 'quarterly_report' });

      expect(mockDb.prepare).toHaveBeenCalled();
      const insertCall = mockDb.prepare.mock.calls.find(
        (call: any[]) => call[0].includes('INSERT INTO audit_reports'),
      );
      expect(insertCall).toBeDefined();
      expect(mockDb.mockRun).toHaveBeenCalledWith(
        expect.any(String), // reportId UUID
        'audit-456',
        'Generated Report - quarterly_report',
        'pending',
      );
    });

    it('should enqueue a generate-pdf job when queueService is available', async () => {
      const mockQueueService = {
        enqueue: vi.fn().mockResolvedValue({ jobId: 'job-123' }),
      };

      const app = createTestApp({ queueService: mockQueueService });

      await authPost(app, '/reports/generate')
        .send({ auditId: 'audit-456', templateTypeKey: 'audit_report' });

      expect(mockQueueService.enqueue).toHaveBeenCalledWith(
        'generate-pdf',
        expect.objectContaining({
          auditId: 'audit-456',
          template: 'audit_report',
          reportId: expect.any(String),
        }),
        expect.objectContaining({
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        }),
      );
    });

    it('should default templateTypeKey to audit_report when not specified', async () => {
      const mockQueueService = {
        enqueue: vi.fn().mockResolvedValue({ jobId: 'job-123' }),
      };

      const app = createTestApp({ queueService: mockQueueService });

      await authPost(app, '/reports/generate')
        .send({ auditId: 'audit-456' });

      expect(mockQueueService.enqueue).toHaveBeenCalledWith(
        'generate-pdf',
        expect.objectContaining({ template: 'audit_report' }),
        expect.any(Object),
      );
    });

    it('should still return 202 even when queueService is not available', async () => {
      const app = createTestApp({ queueService: null });

      const response = await authPost(app, '/reports/generate')
        .send({ auditId: 'audit-456' });

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty('reportId');
    });

    it('should still return 202 when queueService throws', async () => {
      const mockQueueService = {
        enqueue: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      };

      const app = createTestApp({ queueService: mockQueueService });

      const response = await authPost(app, '/reports/generate')
        .send({ auditId: 'audit-456' });

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty('reportId');
    });

    it('should return 400 when auditId is missing', async () => {
      const app = createTestApp();

      const response = await authPost(app, '/reports/generate')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 400 when auditId is empty', async () => {
      const app = createTestApp();

      const response = await authPost(app, '/reports/generate')
        .send({ auditId: '' });

      expect(response.status).toBe(400);
    });

    it('should return 401 when not authenticated', async () => {
      const app = createTestApp();

      const response = await request(app)
        .post('/reports/generate')
        .send({ auditId: 'audit-456' });

      expect(response.status).toBe(401);
    });

    it('should use custom title when provided', async () => {
      const app = createTestApp();
      const mockDb = (app as any)._mockDb;

      await authPost(app, '/reports/generate')
        .send({ auditId: 'audit-456', title: 'My Custom Report' });

      expect(mockDb.mockRun).toHaveBeenCalledWith(
        expect.any(String),
        'audit-456',
        'My Custom Report',
        'pending',
      );
    });
  });

  describe('GET /reports/:reportId/status', () => {
    it('should return 404 when report is not found', async () => {
      const app = createTestApp();

      const response = await authGet(app, '/reports/nonexistent-id/status');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Report not found');
    });

    it('should return pending status without downloadUrl or errorMessage (Req 8.6)', async () => {
      const app = createTestApp();
      const mockDb = (app as any)._mockDb;

      mockDb.mockGet.mockResolvedValue({
        id: 'report-123',
        status: 'pending',
        content: null,
        error: null,
        created_at: new Date().toISOString(), // just now
      });

      const response = await authGet(app, '/reports/report-123/status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'pending' });
      expect(response.body).not.toHaveProperty('downloadUrl');
      expect(response.body).not.toHaveProperty('errorMessage');
    });

    it('should return ready status with downloadUrl when report is ready (Req 8.4)', async () => {
      const mockStorageService = {
        getPresignedUrl: vi.fn().mockResolvedValue('https://minio.local/reports/test.pdf?signed=true'),
      };

      const app = createTestApp({ storageService: mockStorageService });
      const mockDb = (app as any)._mockDb;

      mockDb.mockGet.mockResolvedValue({
        id: 'report-123',
        status: 'ready',
        content: 'audits/audit-456/reports/report-123.pdf',
        error: null,
        created_at: new Date().toISOString(),
      });

      const response = await authGet(app, '/reports/report-123/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ready');
      expect(response.body.downloadUrl).toBe('https://minio.local/reports/test.pdf?signed=true');
    });

    it('should return fallback downloadUrl when storageService is not available', async () => {
      const app = createTestApp({ storageService: null });
      const mockDb = (app as any)._mockDb;

      mockDb.mockGet.mockResolvedValue({
        id: 'report-123',
        status: 'ready',
        content: 'audits/audit-456/reports/report-123.pdf',
        error: null,
        created_at: new Date().toISOString(),
      });

      const response = await authGet(app, '/reports/report-123/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ready');
      expect(response.body.downloadUrl).toBe('/api/v1/reports/report-123/download');
    });

    it('should return failed status with errorMessage (Req 8.4)', async () => {
      const app = createTestApp();
      const mockDb = (app as any)._mockDb;

      mockDb.mockGet.mockResolvedValue({
        id: 'report-123',
        status: 'failed',
        content: null,
        error: 'Audit audit-456 not found',
        created_at: new Date().toISOString(),
      });

      const response = await authGet(app, '/reports/report-123/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('failed');
      expect(response.body.errorMessage).toBe('Audit audit-456 not found');
    });

    it('should return default errorMessage when error field is null', async () => {
      const app = createTestApp();
      const mockDb = (app as any)._mockDb;

      mockDb.mockGet.mockResolvedValue({
        id: 'report-123',
        status: 'failed',
        content: null,
        error: null,
        created_at: new Date().toISOString(),
      });

      const response = await authGet(app, '/reports/report-123/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('failed');
      expect(response.body.errorMessage).toBe('Report generation failed.');
    });

    it('should mark pending report as failed after 5 minutes (Req 8.5)', async () => {
      const app = createTestApp();
      const mockDb = (app as any)._mockDb;

      // Created 6 minutes ago
      const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      mockDb.mockGet.mockResolvedValue({
        id: 'report-123',
        status: 'pending',
        content: null,
        error: null,
        created_at: sixMinutesAgo,
      });

      const response = await authGet(app, '/reports/report-123/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('failed');
      expect(response.body.errorMessage).toContain('timed out');

      // Should have called UPDATE to mark as failed
      const updateCalls = mockDb.prepare.mock.calls.filter(
        (call: any[]) => call[0].includes('UPDATE audit_reports'),
      );
      expect(updateCalls.length).toBeGreaterThan(0);
    });

    it('should NOT mark pending report as failed if within 5 minutes', async () => {
      const app = createTestApp();
      const mockDb = (app as any)._mockDb;

      // Created 3 minutes ago
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      mockDb.mockGet.mockResolvedValue({
        id: 'report-123',
        status: 'pending',
        content: null,
        error: null,
        created_at: threeMinutesAgo,
      });

      const response = await authGet(app, '/reports/report-123/status');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('pending');

      // Should NOT have called UPDATE
      const updateCalls = mockDb.prepare.mock.calls.filter(
        (call: any[]) => call[0].includes('UPDATE audit_reports'),
      );
      expect(updateCalls.length).toBe(0);
    });

    it('should return 401 when not authenticated', async () => {
      const app = createTestApp();

      const response = await request(app).get('/reports/report-123/status');

      expect(response.status).toBe(401);
    });
  });
});
