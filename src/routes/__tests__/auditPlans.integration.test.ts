// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Integration Tests - Audit Plans Routes
 *
 * Tests the audit plans CRUD routes using supertest against a minimal Express app.
 * The audit plans are managed via the generic CRUD generator, so we simulate that pattern.
 */

interface MockAuditPlan {
  id: string;
  title: string;
  department: string;
  type: string;
  risk_rating: string;
  planned_start_date: string;
  planned_end_date: string;
  lead_auditor: string;
  status: string;
  plan_code: string;
}

function createAuditPlansTestApp() {
  const app = express();
  app.use(express.json());

  const plans: MockAuditPlan[] = [
    {
      id: 'plan-1',
      title: 'Q1 Operational Audit',
      department: 'Finance',
      type: 'Operational',
      risk_rating: 'High',
      planned_start_date: '2025-01-15',
      planned_end_date: '2025-03-15',
      lead_auditor: 'John Smith',
      status: 'Planned',
      plan_code: 'IA-PL-25-001',
    },
    {
      id: 'plan-2',
      title: 'Compliance Review',
      department: 'Legal',
      type: 'Compliance',
      risk_rating: 'Medium',
      planned_start_date: '2025-02-01',
      planned_end_date: '2025-04-01',
      lead_auditor: 'Jane Doe',
      status: 'In Progress',
      plan_code: 'IA-PL-25-002',
    },
  ];

  // Simulate authenticate middleware
  const authenticate = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = { id: 'user-1', role: 'Admin', username: 'admin', name: 'Admin User' };
    next();
  };

  // Simulate checkPermission middleware
  const checkPermission = (module: string, action: string) => (req: any, res: any, next: any) => {
    if (req.user.role !== 'Admin' && req.user.role !== 'Manager') {
      return res.status(403).json({ error: `Forbidden: Missing permission ${action} on ${module}` });
    }
    next();
  };

  const router = express.Router();

  // GET all audit plans
  router.get('/', authenticate, checkPermission('Audit Plans', 'View'), (req, res) => {
    const { status, department } = req.query;
    let filtered = [...plans];
    if (status) filtered = filtered.filter(p => p.status === status);
    if (department) filtered = filtered.filter(p => p.department === department);
    res.json({ data: filtered, total: filtered.length });
  });

  // GET single audit plan
  router.get('/:id', authenticate, checkPermission('Audit Plans', 'View'), (req, res) => {
    const plan = plans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: 'Audit plan not found' });
    res.json(plan);
  });

  // POST create audit plan
  router.post('/', authenticate, checkPermission('Audit Plans', 'Create'), (req, res) => {
    const { title, department, type, risk_rating, planned_start_date, planned_end_date, lead_auditor, status } = req.body;
    if (!title || !department) {
      return res.status(400).json({ error: 'Title and department are required' });
    }
    const newPlan: MockAuditPlan = {
      id: `plan-${Date.now()}`,
      title,
      department,
      type: type || 'Operational',
      risk_rating: risk_rating || 'Medium',
      planned_start_date: planned_start_date || '',
      planned_end_date: planned_end_date || '',
      lead_auditor: lead_auditor || '',
      status: status || 'Planned',
      plan_code: `IA-PL-25-${String(plans.length + 1).padStart(3, '0')}`,
    };
    plans.push(newPlan);
    res.status(201).json(newPlan);
  });

  // PUT update audit plan
  router.put('/:id', authenticate, checkPermission('Audit Plans', 'Edit'), (req, res) => {
    const idx = plans.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Audit plan not found' });
    plans[idx] = { ...plans[idx], ...req.body };
    res.json(plans[idx]);
  });

  // DELETE audit plan
  router.delete('/:id', authenticate, checkPermission('Audit Plans', 'Delete'), (req, res) => {
    const idx = plans.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Audit plan not found' });
    plans.splice(idx, 1);
    res.json({ success: true });
  });

  app.use('/api/audit-plans', router);

  return { app };
}

describe('Audit Plans Integration Tests', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    const testApp = createAuditPlansTestApp();
    app = testApp.app;
  });

  describe('GET /api/audit-plans', () => {
    it('should return 200 with list of audit plans when authenticated', async () => {
      const res = await request(app)
        .get('/api/audit-plans')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.length).toBe(2);
      expect(res.body.total).toBe(2);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/audit-plans');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should filter by status query parameter', async () => {
      const res = await request(app)
        .get('/api/audit-plans?status=Planned')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].status).toBe('Planned');
    });

    it('should filter by department query parameter', async () => {
      const res = await request(app)
        .get('/api/audit-plans?department=Finance')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].department).toBe('Finance');
    });
  });

  describe('GET /api/audit-plans/:id', () => {
    it('should return 200 with plan details for valid ID', async () => {
      const res = await request(app)
        .get('/api/audit-plans/plan-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('plan-1');
      expect(res.body.title).toBe('Q1 Operational Audit');
      expect(res.body.plan_code).toBe('IA-PL-25-001');
    });

    it('should return 404 for non-existent plan', async () => {
      const res = await request(app)
        .get('/api/audit-plans/non-existent')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Audit plan not found');
    });
  });

  describe('POST /api/audit-plans', () => {
    it('should return 201 with created plan on valid data', async () => {
      const res = await request(app)
        .post('/api/audit-plans')
        .set('Authorization', 'Bearer valid-token')
        .send({
          title: 'New Audit Plan',
          department: 'IT',
          type: 'IT',
          risk_rating: 'High',
          planned_start_date: '2025-06-01',
          planned_end_date: '2025-08-01',
          lead_auditor: 'Bob',
          status: 'Planned',
        });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('New Audit Plan');
      expect(res.body.department).toBe('IT');
      expect(res.body.plan_code).toBeDefined();
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/audit-plans')
        .set('Authorization', 'Bearer valid-token')
        .send({ type: 'Operational' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/api/audit-plans')
        .send({ title: 'Test', department: 'IT' });

      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/audit-plans/:id', () => {
    it('should return 200 with updated plan', async () => {
      const res = await request(app)
        .put('/api/audit-plans/plan-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ title: 'Updated Title', status: 'In Progress' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Updated Title');
      expect(res.body.status).toBe('In Progress');
    });

    it('should return 404 for non-existent plan', async () => {
      const res = await request(app)
        .put('/api/audit-plans/non-existent')
        .set('Authorization', 'Bearer valid-token')
        .send({ title: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/audit-plans/:id', () => {
    it('should return 200 on successful deletion', async () => {
      const res = await request(app)
        .delete('/api/audit-plans/plan-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 404 for non-existent plan', async () => {
      const res = await request(app)
        .delete('/api/audit-plans/non-existent')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).delete('/api/audit-plans/plan-1');

      expect(res.status).toBe(401);
    });
  });
});
