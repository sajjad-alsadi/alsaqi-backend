// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole, ADMIN_ROLES, STAFF_ROLES } from '@alsaqi/shared';
import { globalErrorHandler } from '../../middleware/error';

/**
 * Integration Tests - Correspondence Routes
 *
 * Tests the correspondence routes using supertest against a minimal Express app
 * with mocked CorrespondenceService and AuthService.
 * Covers incoming/outgoing CRUD, status updates, referrals, linking, archiving,
 * validation, and authorization.
 */

// Mock CorrespondenceService and AuthService
const mockCorrespondenceService = {
  getIncoming: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  createIncoming: vi.fn().mockResolvedValue({ id: 'inc-1', sequence_number: 'INC-25-001' }),
  updateIncoming: vi.fn().mockResolvedValue(undefined),
  deleteIncoming: vi.fn().mockResolvedValue(undefined),
  updateStatus: vi.fn().mockResolvedValue({ oldStatus: 'Received', newStatus: 'In Progress' }),
  refer: vi.fn().mockResolvedValue(undefined),
  link: vi.fn().mockResolvedValue(undefined),
  archive: vi.fn().mockResolvedValue(undefined),
  getOutgoing: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  createOutgoing: vi.fn().mockResolvedValue({ id: 'out-1', sequence_number: 'OUT-25-001' }),
  getStats: vi.fn().mockResolvedValue({ incoming: 10, outgoing: 5, archived: 3 }),
};

const mockAuthService = {
  logAudit: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../services/CorrespondenceService', () => ({
  CorrespondenceService: {
    getIncoming: (...args: any[]) => mockCorrespondenceService.getIncoming(...args),
    createIncoming: (...args: any[]) => mockCorrespondenceService.createIncoming(...args),
    updateIncoming: (...args: any[]) => mockCorrespondenceService.updateIncoming(...args),
    deleteIncoming: (...args: any[]) => mockCorrespondenceService.deleteIncoming(...args),
    updateStatus: (...args: any[]) => mockCorrespondenceService.updateStatus(...args),
    refer: (...args: any[]) => mockCorrespondenceService.refer(...args),
    link: (...args: any[]) => mockCorrespondenceService.link(...args),
    archive: (...args: any[]) => mockCorrespondenceService.archive(...args),
    getOutgoing: (...args: any[]) => mockCorrespondenceService.getOutgoing(...args),
    createOutgoing: (...args: any[]) => mockCorrespondenceService.createOutgoing(...args),
    getStats: (...args: any[]) => mockCorrespondenceService.getStats(...args),
  },
}));

vi.mock('../../services/AuthService', () => ({
  AuthService: {
    logAudit: (...args: any[]) => mockAuthService.logAudit(...args),
  },
}));

// Import createCorrespondenceRoutes after mocks are set up
import { createCorrespondenceRoutes } from '../correspondence';

function createCorrespondenceTestApp(options?: {
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
    const role = req.user?.role;
    if (!role) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    // Admin and Manager can do everything
    if (['Admin', 'Manager'].includes(role)) {
      return next();
    }
    // Internal Auditor can Create and Edit but not Delete
    if (role === 'Internal Auditor' && action && ['Create', 'Edit'].includes(action)) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
  };

  const logError = vi.fn();
  const saveFile = vi.fn().mockResolvedValue('/uploads/mock-file.pdf');

  // Mount the routes using the imported function (mocks are already set up)
  const router = createCorrespondenceRoutes(null, authenticate, authorize, logError, saveFile);
  app.use('/api/correspondence', router);
  app.use(globalErrorHandler);

  return { app, saveFile };
}

describe('Correspondence Integration Tests', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    const testApp = createCorrespondenceTestApp();
    app = testApp.app;
  });

  describe('GET /api/correspondence/incoming', () => {
    it('should return 200 with incoming correspondence list', async () => {
      mockCorrespondenceService.getIncoming.mockResolvedValueOnce({
        data: [{ id: 'inc-1', subject: 'Test Letter' }],
        total: 1,
      });

      const res = await request(app)
        .get('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.total).toBe(1);
      expect(mockCorrespondenceService.getIncoming).toHaveBeenCalled();
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/correspondence/incoming');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/correspondence/incoming', () => {
    const validIncoming = {
      letter_number: 'LTR-001',
      sender_entity: 'البنك المركزي العراقي',
      subject: 'موضوع المراسلة',
      letter_date: '2025-01-15',
      receipt_date: '2025-01-16',
    };

    it('should return 200 on valid incoming creation', async () => {
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token')
        .send(validIncoming);

      expect(res.status).toBe(200);
      expect(res.body.sequence_number).toBe('INC-25-001');
      expect(mockCorrespondenceService.createIncoming).toHaveBeenCalledWith(
        expect.objectContaining({ letter_number: 'LTR-001' }),
        'test-user-id'
      );
      expect(mockAuthService.logAudit).toHaveBeenCalledWith(
        'testuser', 'CREATE', 'Correspondence', expect.stringContaining('INC-25-001')
      );
    });

    it('should reject when letter_number is empty', async () => {
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validIncoming, letter_number: '' });

      expect(res.status).toBe(400);
    });

    it('should reject when letter_number exceeds 100 characters', async () => {
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validIncoming, letter_number: 'x'.repeat(101) });

      expect(res.status).toBe(400);
    });

    it('should reject when sender_entity is empty', async () => {
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validIncoming, sender_entity: '' });

      expect(res.status).toBe(400);
    });

    it('should reject when sender_entity exceeds 255 characters', async () => {
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validIncoming, sender_entity: 'x'.repeat(256) });

      expect(res.status).toBe(400);
    });

    it('should reject when subject is empty', async () => {
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validIncoming, subject: '' });

      expect(res.status).toBe(400);
    });

    it('should reject when subject exceeds 500 characters', async () => {
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validIncoming, subject: 'x'.repeat(501) });

      expect(res.status).toBe(400);
    });

    it('should reject when letter_date is missing', async () => {
      const { letter_date, ...noDate } = validIncoming;
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token')
        .send(noDate);

      expect(res.status).toBe(400);
    });

    it('should reject when receipt_date is missing', async () => {
      const { receipt_date, ...noReceipt } = validIncoming;
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer valid-token')
        .send(noReceipt);

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/correspondence/incoming/:id', () => {
    it('should return 200 on valid update by Admin', async () => {
      const res = await request(app)
        .put('/api/correspondence/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ subject: 'Updated Subject' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCorrespondenceService.updateIncoming).toHaveBeenCalledWith('inc-1', expect.any(Object));
    });

    it('should return 403 for non-admin roles', async () => {
      const { app: viewerApp } = createCorrespondenceTestApp({
        authenticatedRole: UserRole.COMPLIANCE_OFFICER,
      });

      const res = await request(viewerApp)
        .put('/api/correspondence/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ subject: 'Updated' });

      expect(res.status).toBe(403);
    });

    it('should allow Manager role (part of ADMIN_ROLES)', async () => {
      const { app: managerApp } = createCorrespondenceTestApp({
        authenticatedRole: UserRole.MANAGER,
      });

      const res = await request(managerApp)
        .put('/api/correspondence/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ subject: 'Manager Update' });

      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /api/correspondence/incoming/:id', () => {
    it('should return 200 on successful deletion by Admin', async () => {
      const res = await request(app)
        .delete('/api/correspondence/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCorrespondenceService.deleteIncoming).toHaveBeenCalledWith('inc-1');
      expect(mockAuthService.logAudit).toHaveBeenCalledWith(
        'testuser', 'DELETE', 'Correspondence', expect.stringContaining('inc-1')
      );
    });

    it('should return 403 for non-admin roles', async () => {
      const { app: auditorApp } = createCorrespondenceTestApp({
        authenticatedRole: UserRole.INTERNAL_AUDITOR,
      });

      const res = await request(auditorApp)
        .delete('/api/correspondence/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/correspondence/status/:type/:id', () => {
    it('should return 200 on valid status update', async () => {
      const res = await request(app)
        .put('/api/correspondence/status/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ new_status: 'In Progress' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCorrespondenceService.updateStatus).toHaveBeenCalledWith(
        'incoming', 'inc-1', 'In Progress', '', 'test-user-id'
      );
    });

    it('should reject when new_status is missing', async () => {
      const res = await request(app)
        .put('/api/correspondence/status/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should reject when new_status is empty string', async () => {
      const res = await request(app)
        .put('/api/correspondence/status/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ new_status: '' });

      expect(res.status).toBe(400);
    });

    it('should accept optional notes field', async () => {
      const res = await request(app)
        .put('/api/correspondence/status/outgoing/out-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ new_status: 'Sent', notes: 'Sent via official mail' });

      expect(res.status).toBe(200);
      expect(mockCorrespondenceService.updateStatus).toHaveBeenCalledWith(
        'outgoing', 'out-1', 'Sent', 'Sent via official mail', 'test-user-id'
      );
    });
  });

  describe('POST /api/correspondence/refer', () => {
    const validReferral = {
      incoming_id: '550e8400-e29b-41d4-a716-446655440000',
      to_dept_id: '660e8400-e29b-41d4-a716-446655440000',
    };

    it('should return 200 on valid referral', async () => {
      const res = await request(app)
        .post('/api/correspondence/refer')
        .set('Authorization', 'Bearer valid-token')
        .send(validReferral);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCorrespondenceService.refer).toHaveBeenCalledWith(
        expect.objectContaining(validReferral),
        'test-user-id'
      );
    });

    it('should reject when incoming_id is not a valid UUID', async () => {
      const res = await request(app)
        .post('/api/correspondence/refer')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validReferral, incoming_id: 'not-a-uuid' });

      expect(res.status).toBe(400);
    });

    it('should reject when to_dept_id is not a valid UUID', async () => {
      const res = await request(app)
        .post('/api/correspondence/refer')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validReferral, to_dept_id: 'invalid' });

      expect(res.status).toBe(400);
    });

    it('should reject when incoming_id is missing', async () => {
      const res = await request(app)
        .post('/api/correspondence/refer')
        .set('Authorization', 'Bearer valid-token')
        .send({ to_dept_id: validReferral.to_dept_id });

      expect(res.status).toBe(400);
    });

    it('should reject when to_dept_id is missing', async () => {
      const res = await request(app)
        .post('/api/correspondence/refer')
        .set('Authorization', 'Bearer valid-token')
        .send({ incoming_id: validReferral.incoming_id });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/correspondence/link', () => {
    const validLink = {
      incoming_id: '550e8400-e29b-41d4-a716-446655440000',
      outgoing_id: '660e8400-e29b-41d4-a716-446655440000',
    };

    it('should return 200 on valid link', async () => {
      const res = await request(app)
        .post('/api/correspondence/link')
        .set('Authorization', 'Bearer valid-token')
        .send(validLink);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCorrespondenceService.link).toHaveBeenCalledWith(
        expect.objectContaining({ ...validLink, link_type: 'Reply' }),
        'test-user-id'
      );
    });

    it('should reject when incoming_id is not a valid UUID', async () => {
      const res = await request(app)
        .post('/api/correspondence/link')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validLink, incoming_id: 'bad-id' });

      expect(res.status).toBe(400);
    });

    it('should reject when outgoing_id is not a valid UUID', async () => {
      const res = await request(app)
        .post('/api/correspondence/link')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validLink, outgoing_id: 'bad-id' });

      expect(res.status).toBe(400);
    });

    it('should accept optional link_type', async () => {
      const res = await request(app)
        .post('/api/correspondence/link')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validLink, link_type: 'Follow-up' });

      expect(res.status).toBe(200);
      expect(mockCorrespondenceService.link).toHaveBeenCalledWith(
        expect.objectContaining({ link_type: 'Follow-up' }),
        'test-user-id'
      );
    });
  });

  describe('PUT /api/correspondence/archive/:type/:id', () => {
    it('should return 200 on successful archive', async () => {
      const res = await request(app)
        .put('/api/correspondence/archive/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockCorrespondenceService.archive).toHaveBeenCalledWith('incoming', 'inc-1');
      expect(mockAuthService.logAudit).toHaveBeenCalledWith(
        'testuser', 'ARCHIVE', 'Correspondence', expect.stringContaining('incoming')
      );
    });

    it('should work for outgoing type', async () => {
      const res = await request(app)
        .put('/api/correspondence/archive/outgoing/out-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(mockCorrespondenceService.archive).toHaveBeenCalledWith('outgoing', 'out-1');
    });
  });

  describe('GET /api/correspondence/outgoing', () => {
    it('should return 200 with outgoing correspondence list', async () => {
      mockCorrespondenceService.getOutgoing.mockResolvedValueOnce({
        data: [{ id: 'out-1', subject: 'Outgoing Letter' }],
        total: 1,
      });

      const res = await request(app)
        .get('/api/correspondence/outgoing')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(mockCorrespondenceService.getOutgoing).toHaveBeenCalled();
    });

    it('should pass pagination params', async () => {
      const res = await request(app)
        .get('/api/correspondence/outgoing?page=2&pageSize=20')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(mockCorrespondenceService.getOutgoing).toHaveBeenCalledWith(2, 20);
    });
  });

  describe('POST /api/correspondence/outgoing', () => {
    const validOutgoing = {
      letter_date: '2025-01-15',
      recipient_entity: 'وزارة المالية',
      subject: 'موضوع الصادرة',
    };

    it('should return 200 on valid outgoing creation by Admin', async () => {
      const res = await request(app)
        .post('/api/correspondence/outgoing')
        .set('Authorization', 'Bearer valid-token')
        .send(validOutgoing);

      expect(res.status).toBe(200);
      expect(res.body.sequence_number).toBe('OUT-25-001');
      expect(mockCorrespondenceService.createOutgoing).toHaveBeenCalledWith(
        expect.objectContaining({ recipient_entity: 'وزارة المالية' }),
        'test-user-id'
      );
    });

    it('should allow Internal Auditor (part of STAFF_ROLES)', async () => {
      const { app: auditorApp } = createCorrespondenceTestApp({
        authenticatedRole: UserRole.INTERNAL_AUDITOR,
      });

      const res = await request(auditorApp)
        .post('/api/correspondence/outgoing')
        .set('Authorization', 'Bearer valid-token')
        .send(validOutgoing);

      expect(res.status).toBe(200);
    });

    it('should return 403 for roles not in STAFF_ROLES', async () => {
      const { app: complianceApp } = createCorrespondenceTestApp({
        authenticatedRole: UserRole.COMPLIANCE_OFFICER,
      });

      const res = await request(complianceApp)
        .post('/api/correspondence/outgoing')
        .set('Authorization', 'Bearer valid-token')
        .send(validOutgoing);

      expect(res.status).toBe(403);
    });

    it('should reject when letter_date is missing', async () => {
      const { letter_date, ...noDate } = validOutgoing;
      const res = await request(app)
        .post('/api/correspondence/outgoing')
        .set('Authorization', 'Bearer valid-token')
        .send(noDate);

      expect(res.status).toBe(400);
    });

    it('should reject when recipient_entity is empty', async () => {
      const res = await request(app)
        .post('/api/correspondence/outgoing')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validOutgoing, recipient_entity: '' });

      expect(res.status).toBe(400);
    });

    it('should reject when subject is empty', async () => {
      const res = await request(app)
        .post('/api/correspondence/outgoing')
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validOutgoing, subject: '' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/correspondence/stats', () => {
    it('should return 200 with statistics', async () => {
      const res = await request(app)
        .get('/api/correspondence/stats')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.incoming).toBe(10);
      expect(res.body.outgoing).toBe(5);
      expect(res.body.archived).toBe(3);
      expect(mockCorrespondenceService.getStats).toHaveBeenCalled();
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/correspondence/stats');
      expect(res.status).toBe(401);
    });
  });

  describe('Authorization - Role-based access', () => {
    it('should return 403 for Risk Officer on PUT incoming (requires ADMIN_ROLES)', async () => {
      const { app: riskApp } = createCorrespondenceTestApp({
        authenticatedRole: UserRole.RISK_OFFICER,
      });

      const res = await request(riskApp)
        .put('/api/correspondence/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ subject: 'Attempt' });

      expect(res.status).toBe(403);
    });

    it('should return 403 for Risk Officer on DELETE incoming (requires ADMIN_ROLES)', async () => {
      const { app: riskApp } = createCorrespondenceTestApp({
        authenticatedRole: UserRole.RISK_OFFICER,
      });

      const res = await request(riskApp)
        .delete('/api/correspondence/incoming/inc-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
    });

    it('should return 403 for Risk Officer on POST outgoing (requires STAFF_ROLES)', async () => {
      const { app: riskApp } = createCorrespondenceTestApp({
        authenticatedRole: UserRole.RISK_OFFICER,
      });

      const res = await request(riskApp)
        .post('/api/correspondence/outgoing')
        .set('Authorization', 'Bearer valid-token')
        .send({
          letter_date: '2025-01-15',
          recipient_entity: 'Test',
          subject: 'Test',
        });

      expect(res.status).toBe(403);
    });
  });
});
