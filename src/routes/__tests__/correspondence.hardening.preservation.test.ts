// @vitest-environment node
/**
 * Spec: correspondence-api-hardening-fixes — Task 2: Preservation property tests (route + schema layer)
 *
 * Property 2: Preservation — for every input where NO bug condition holds (¬C(X)), the fixed
 * code must behave identically to the current code. These RECORD the current correct baseline on
 * the UNFIXED code and are EXPECTED TO PASS as written.
 *
 * Validates: Requirements 3.1, 3.2, 3.3
 *
 * The route schemas are exercised end-to-end via supertest with a mocked CorrespondenceService
 * (mirroring correspondence.integration.test.ts), so a 200 means the request passed route-level
 * validation and authorization. `idParamSchema` (the exported int-or-UUID id refinement) is
 * additionally property-checked directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fc from 'fast-check';
import {
  PRIORITIES,
  CLASSIFICATIONS,
  METHODS,
  ENTITY_TYPES,
  LINK_TYPES,
  INCOMING_STATUSES,
  OUTGOING_STATUSES,
} from '@alsaqi/shared';
import { globalErrorHandler } from '../../middleware/error';
import { idParamSchema } from '../../schemas';

// ─── Mocked service (a 200 therefore proves validation + authorization passed) ──
// `mockService` is created via vi.hoisted so the (hoisted) vi.mock factory below can reference it.
const { mockService } = vi.hoisted(() => ({
  mockService: {
    getIncoming: vi.fn(async () => ({ data: [], total: 0 })),
    createIncoming: vi.fn(async () => ({ id: 'inc-1', sequence_number: 'INC-25-001' })),
    updateIncoming: vi.fn(async () => undefined),
    deleteIncoming: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => ({ oldStatus: 'Received', newStatus: 'Under Review' })),
    refer: vi.fn(async () => undefined),
    link: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    getArchive: vi.fn(async () => ({ data: [], pagination: {} })),
    getAttachments: vi.fn(async () => []),
    addAttachment: vi.fn(async () => undefined),
    getDetails: vi.fn(async () => ({ main: {}, attachments: [], history: [], links: [], referrals: [] })),
    getStats: vi.fn(async () => ({})),
    getOutgoing: vi.fn(async () => ({ data: [], total: 0 })),
    createOutgoing: vi.fn(async () => ({ id: 'out-1', sequence_number: 'OUT-25-001' })),
    updateOutgoing: vi.fn(async () => undefined),
    deleteOutgoing: vi.fn(async () => undefined),
  } as Record<string, any>,
}));

vi.mock('../../services/CorrespondenceService', () => ({
  CorrespondenceService: new Proxy(mockService, {
    get: (target: Record<string, any>, prop: string) => (...args: any[]) => target[prop]?.(...args),
  }),
}));
vi.mock('../../services/AuthService', () => ({ AuthService: { logAudit: vi.fn(async () => undefined) } }));

import { createCorrespondenceRoutes } from '../correspondence';

const UUID1 = '550e8400-e29b-41d4-a716-446655440000';
const UUID2 = '660e8400-e29b-41d4-a716-446655440000';

type Perm = { module: string; action?: string };

/**
 * Builds the app. `denyPerm` lets a test simulate a user that lacks a specific permission so the
 * route's `checkPermission(module, action)` guard returns 403 (used to prove the /link guard).
 */
function buildApp(opts?: { role?: string; denyPerm?: (p: Perm) => boolean; permCalls?: Perm[] }) {
  const app = express();
  app.use(express.json());

  const authenticate = (req: any, res: any, next: any) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    req.user = {
      id: UUID1,
      role: opts?.role ?? 'Admin',
      username: 'tester',
      name: 'Tester',
      email: 't@example.com',
    };
    next();
  };

  const checkPermission = (module: string, action?: string) => {
    opts?.permCalls?.push({ module, action });
    return (_req: any, res: any, next: any) => {
      if (opts?.denyPerm?.({ module, action })) {
        return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      }
      next();
    };
  };

  const router = createCorrespondenceRoutes(null, authenticate, checkPermission, vi.fn(), vi.fn());
  app.use('/api/correspondence', router);
  app.use(globalErrorHandler);
  return app;
}

const validIncoming = {
  letter_number: 'LTR-001',
  sender_entity: 'Central Bank',
  subject: 'Subject',
  letter_date: '2025-01-15',
  receipt_date: '2025-01-16',
};
const validOutgoing = { letter_date: '2025-01-15', recipient_entity: 'Ministry', subject: 'Subject' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Property 2: Preservation — correspondence routes (correspondence-api-hardening-fixes)', () => {
  // ── 3.1 Valid enum values are accepted across ALL enum fields ────────────────
  // @alsaqi/shared remains the single source of truth: every value in each shared constant
  // array is accepted by the route schema that consumes it.
  describe('Req 3.1 — valid enum values are accepted (single source of truth = @alsaqi/shared)', () => {
    const incomingEnumFields = [
      { field: 'priority', constants: PRIORITIES },
      { field: 'classification', constants: CLASSIFICATIONS },
      { field: 'method', constants: METHODS },
      { field: 'sender_entity_type', constants: ENTITY_TYPES },
    ] as const;

    for (const { field, constants } of incomingEnumFields) {
      it(`POST /incoming accepts every valid ${field} value`, async () => {
        const app = buildApp();
        await fc.assert(
          fc.asyncProperty(fc.constantFrom(...constants), async (value) => {
            const res = await request(app)
              .post('/api/correspondence/incoming')
              .set('Authorization', 'Bearer t')
              .send({ ...validIncoming, [field]: value });
            expect(res.status).toBe(200);
          }),
          { numRuns: 20 },
        );
      });
    }

    const outgoingEnumFields = [
      { field: 'classification', constants: CLASSIFICATIONS },
      { field: 'sending_method', constants: METHODS },
    ] as const;

    for (const { field, constants } of outgoingEnumFields) {
      it(`POST /outgoing accepts every valid ${field} value`, async () => {
        const app = buildApp();
        await fc.assert(
          fc.asyncProperty(fc.constantFrom(...constants), async (value) => {
            const res = await request(app)
              .post('/api/correspondence/outgoing')
              .set('Authorization', 'Bearer t')
              .send({ ...validOutgoing, [field]: value });
            expect(res.status).toBe(200);
          }),
          { numRuns: 20 },
        );
      });
    }

    it('POST /link accepts every valid link_type value', async () => {
      const app = buildApp();
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...LINK_TYPES), async (value) => {
          const res = await request(app)
            .post('/api/correspondence/link')
            .set('Authorization', 'Bearer t')
            .send({ incoming_id: UUID1, outgoing_id: UUID2, link_type: value });
          expect(res.status).toBe(200);
        }),
        { numRuns: 20 },
      );
    });

    it('PUT /status/incoming accepts every valid INCOMING_STATUSES value', async () => {
      const app = buildApp();
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...INCOMING_STATUSES), async (value) => {
          const res = await request(app)
            .put(`/api/correspondence/status/incoming/${UUID1}`)
            .set('Authorization', 'Bearer t')
            .send({ new_status: value });
          expect(res.status).toBe(200);
        }),
        { numRuns: 20 },
      );
    });

    it('PUT /status/outgoing accepts every valid OUTGOING_STATUSES value', async () => {
      const app = buildApp();
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...OUTGOING_STATUSES), async (value) => {
          const res = await request(app)
            .put(`/api/correspondence/status/outgoing/${UUID2}`)
            .set('Authorization', 'Bearer t')
            .send({ new_status: value });
          expect(res.status).toBe(200);
        }),
        { numRuns: 20 },
      );
    });
  });

  // ── 3.2 Authorized mutations served + POST /link requires Correspondence:Edit ─
  describe('Req 3.2 — authorized mutations served; POST /link requires Correspondence:Edit', () => {
    it('3.2a serves authorized mutations across the correspondence surface', async () => {
      const app = buildApp(); // Admin, permissive checkPermission
      const calls: Array<Promise<request.Response>> = [
        request(app).post('/api/correspondence/incoming').set('Authorization', 'Bearer t').send(validIncoming),
        request(app).put(`/api/correspondence/incoming/${UUID1}`).set('Authorization', 'Bearer t').send({ subject: 'Edit' }),
        request(app).delete(`/api/correspondence/incoming/${UUID1}`).set('Authorization', 'Bearer t'),
        request(app).post('/api/correspondence/outgoing').set('Authorization', 'Bearer t').send(validOutgoing),
        request(app).post('/api/correspondence/refer').set('Authorization', 'Bearer t').send({ incoming_id: UUID1, to_dept_id: UUID2 }),
        request(app).post('/api/correspondence/link').set('Authorization', 'Bearer t').send({ incoming_id: UUID1, outgoing_id: UUID2 }),
        request(app).put(`/api/correspondence/archive/incoming/${UUID1}`).set('Authorization', 'Bearer t'),
        request(app).put(`/api/correspondence/status/incoming/${UUID1}`).set('Authorization', 'Bearer t').send({ new_status: 'Under Review' }),
      ];
      const results = await Promise.all(calls);
      for (const res of results) expect(res.status).toBe(200);
    });

    it('3.2b POST /link is gated by checkPermission("Correspondence","Edit")', async () => {
      // The route is registered with this exact (module, action) guard.
      const permCalls: Perm[] = [];
      buildApp({ permCalls });
      expect(permCalls).toContainEqual({ module: 'Correspondence', action: 'Edit' });

      // Functional proof: a principal denied Correspondence:Edit is blocked on POST /link (403)…
      const deniedApp = buildApp({
        denyPerm: (p) => p.module === 'Correspondence' && p.action === 'Edit',
      });
      const denied = await request(deniedApp)
        .post('/api/correspondence/link')
        .set('Authorization', 'Bearer t')
        .send({ incoming_id: UUID1, outgoing_id: UUID2 });
      expect(denied.status).toBe(403);

      // …while a principal granted the permission is served.
      const allowedApp = buildApp();
      const allowed = await request(allowedApp)
        .post('/api/correspondence/link')
        .set('Authorization', 'Bearer t')
        .send({ incoming_id: UUID1, outgoing_id: UUID2 });
      expect(allowed.status).toBe(200);
    });
  });

  // ── 3.3 int-or-UUID ids accepted by idParamSchema / typeIdParamSchema ────────
  describe('Req 3.3 — integer OR UUID ids are accepted', () => {
    const idArb = fc.oneof(fc.nat({ max: 2 ** 31 }).map((n) => String(n)), fc.uuid());

    it('3.3a idParamSchema accepts any integer or UUID id', () => {
      fc.assert(
        fc.property(idArb, (id) => {
          expect(idParamSchema.safeParse({ id }).success).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('3.3b a :type/:id route (typeIdParamSchema) accepts integer or UUID ids for both types', async () => {
      const app = buildApp();
      await fc.assert(
        fc.asyncProperty(fc.constantFrom('incoming', 'outgoing'), idArb, async (type, id) => {
          const res = await request(app)
            .get(`/api/correspondence/details/${type}/${id}`)
            .set('Authorization', 'Bearer t');
          // A valid type + int/UUID id passes param validation (200); it is never a 400.
          expect(res.status).toBe(200);
        }),
        { numRuns: 40 },
      );
    });
  });
});
