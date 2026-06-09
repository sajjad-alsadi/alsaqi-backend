// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Integration Tests - Findings Routes
 *
 * Tests the findings CRUD routes using supertest against a minimal Express app.
 * Findings are managed via the generic CRUD generator pattern.
 */

interface MockFinding {
  id: string;
  audit_id: string;
  finding_number: string;
  plan_code: string;
  condition: string;
  criteria: string;
  cause: string;
  consequence: string;
  recommendation: string;
  risk_level: string;
  status: string;
}

function createFindingsTestApp() {
  const app = express();
  app.use(express.json());

  const findings: MockFinding[] = [
    {
      id: 'finding-1',
      audit_id: 'plan-1',
      finding_number: 'IA-PL-25-001-FD-001',
      plan_code: 'IA-PL-25-001',
      condition: 'Weak access controls',
      criteria: 'ISO 27001 A.9',
      cause: 'Lack of review process',
      consequence: 'Unauthorized access risk',
      recommendation: 'Implement quarterly access reviews',
      risk_level: 'High',
      status: 'Open',
    },
    {
      id: 'finding-2',
      audit_id: 'plan-1',
      finding_number: 'IA-PL-25-001-FD-002',
      plan_code: 'IA-PL-25-001',
      condition: 'Missing backup verification',
      criteria: 'Company backup policy',
      cause: 'No automated testing',
      consequence: 'Data loss risk',
      recommendation: 'Automate backup verification',
      risk_level: 'Medium',
      status: 'In Progress',
    },
    {
      id: 'finding-3',
      audit_id: 'plan-2',
      finding_number: 'IA-PL-25-002-FD-001',
      plan_code: 'IA-PL-25-002',
      condition: 'Outdated policies',
      criteria: 'Regulatory requirement',
      cause: 'No annual review cycle',
      consequence: 'Non-compliance',
      recommendation: 'Establish annual policy review',
      risk_level: 'Low',
      status: 'Closed',
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

  const checkPermission = (module: string, action: string) => (req: any, res: any, next: any) => {
    if (req.user.role !== 'Admin' && req.user.role !== 'Manager' && req.user.role !== 'Internal Auditor') {
      return res.status(403).json({ error: `Forbidden: Missing permission ${action} on ${module}` });
    }
    next();
  };

  const router = express.Router();

  // GET all findings
  router.get('/', authenticate, checkPermission('Findings', 'View'), (req, res) => {
    const { audit_id, risk_level, status } = req.query;
    let filtered = [...findings];
    if (audit_id) filtered = filtered.filter(f => f.audit_id === audit_id);
    if (risk_level) filtered = filtered.filter(f => f.risk_level === risk_level);
    if (status) filtered = filtered.filter(f => f.status === status);
    res.json({ data: filtered, total: filtered.length });
  });

  // GET single finding
  router.get('/:id', authenticate, checkPermission('Findings', 'View'), (req, res) => {
    const finding = findings.find(f => f.id === req.params.id);
    if (!finding) return res.status(404).json({ error: 'Finding not found' });
    res.json(finding);
  });

  // POST create finding
  router.post('/', authenticate, checkPermission('Findings', 'Create'), (req, res) => {
    const { audit_id, condition, criteria, cause, consequence, recommendation, risk_level } = req.body;
    if (!audit_id || !condition || !risk_level) {
      return res.status(400).json({ error: 'audit_id, condition, and risk_level are required' });
    }
    const newFinding: MockFinding = {
      id: `finding-${Date.now()}`,
      audit_id,
      finding_number: `IA-PL-25-001-FD-${String(findings.length + 1).padStart(3, '0')}`,
      plan_code: 'IA-PL-25-001',
      condition,
      criteria: criteria || '',
      cause: cause || '',
      consequence: consequence || '',
      recommendation: recommendation || '',
      risk_level,
      status: 'Open',
    };
    findings.push(newFinding);
    res.status(201).json(newFinding);
  });

  // PUT update finding
  router.put('/:id', authenticate, checkPermission('Findings', 'Edit'), (req, res) => {
    const idx = findings.findIndex(f => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Finding not found' });
    findings[idx] = { ...findings[idx], ...req.body };
    res.json(findings[idx]);
  });

  // DELETE finding
  router.delete('/:id', authenticate, checkPermission('Findings', 'Delete'), (req, res) => {
    const idx = findings.findIndex(f => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Finding not found' });
    findings.splice(idx, 1);
    res.json({ success: true });
  });

  app.use('/api/findings', router);

  return { app };
}

describe('Findings Integration Tests', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    const testApp = createFindingsTestApp();
    app = testApp.app;
  });

  describe('GET /api/findings', () => {
    it('should return 200 with list of findings when authenticated', async () => {
      const res = await request(app)
        .get('/api/findings')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.length).toBe(3);
      expect(res.body.total).toBe(3);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/findings');

      expect(res.status).toBe(401);
    });

    it('should filter by audit_id', async () => {
      const res = await request(app)
        .get('/api/findings?audit_id=plan-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.data.every((f: any) => f.audit_id === 'plan-1')).toBe(true);
    });

    it('should filter by risk_level', async () => {
      const res = await request(app)
        .get('/api/findings?risk_level=High')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].risk_level).toBe('High');
    });

    it('should filter by status', async () => {
      const res = await request(app)
        .get('/api/findings?status=Closed')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].status).toBe('Closed');
    });
  });

  describe('GET /api/findings/:id', () => {
    it('should return 200 with finding details for valid ID', async () => {
      const res = await request(app)
        .get('/api/findings/finding-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('finding-1');
      expect(res.body.finding_number).toBe('IA-PL-25-001-FD-001');
      expect(res.body.condition).toBe('Weak access controls');
    });

    it('should return 404 for non-existent finding', async () => {
      const res = await request(app)
        .get('/api/findings/non-existent')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Finding not found');
    });
  });

  describe('POST /api/findings', () => {
    it('should return 201 with created finding on valid data', async () => {
      const res = await request(app)
        .post('/api/findings')
        .set('Authorization', 'Bearer valid-token')
        .send({
          audit_id: 'plan-1',
          condition: 'New finding condition',
          criteria: 'Test criteria',
          cause: 'Test cause',
          consequence: 'Test consequence',
          recommendation: 'Test recommendation',
          risk_level: 'High',
        });

      expect(res.status).toBe(201);
      expect(res.body.condition).toBe('New finding condition');
      expect(res.body.risk_level).toBe('High');
      expect(res.body.status).toBe('Open');
      expect(res.body.finding_number).toBeDefined();
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/findings')
        .set('Authorization', 'Bearer valid-token')
        .send({ criteria: 'Only criteria' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });
  });

  describe('PUT /api/findings/:id', () => {
    it('should return 200 with updated finding', async () => {
      const res = await request(app)
        .put('/api/findings/finding-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'In Progress', recommendation: 'Updated recommendation' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('In Progress');
      expect(res.body.recommendation).toBe('Updated recommendation');
    });

    it('should return 404 for non-existent finding', async () => {
      const res = await request(app)
        .put('/api/findings/non-existent')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'Closed' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/findings/:id', () => {
    it('should return 200 on successful deletion', async () => {
      const res = await request(app)
        .delete('/api/findings/finding-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 404 for non-existent finding', async () => {
      const res = await request(app)
        .delete('/api/findings/non-existent')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
    });
  });
});
