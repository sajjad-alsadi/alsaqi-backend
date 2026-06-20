// @vitest-environment node
/**
 * Spec: correspondence-api-hardening-fixes — Task 8.2: Expanded route-level coverage
 *
 * Findings 1.8 (thin negative/404 coverage) -> 2.8, and 1.10 (PATCH semantics
 * unratified) -> 2.10 [DECISION: keep PATCH].
 *
 * **Validates: Requirements 1.8, 1.10, 2.8, 2.10**
 *
 * The pre-existing `correspondence.integration.test.ts` only exercised happy paths
 * (valid UUIDs / valid statuses). This suite adds the negative + contract coverage
 * that finding 1.8 says was missing:
 *   - out-of-enum rejection (invalid `priority`, invalid `new_status`, invalid `link_type`) -> 400
 *   - invalid `:type` path param (e.g. `/details/bogus/<id>`) -> 400
 *   - malformed `:id` path param (neither integer nor UUID) -> 400
 *   - the NEW 404 responses on update / delete / status / archive of a missing or
 *     soft-deleted row (the service throws `NotFoundError`, asserted to map to HTTP 404)
 *   - archive `?type` casing: `?type=Incoming` (capitalized) -> 400; `?type=incoming` -> 200
 *   - attachment body casing: `correspondence_type: 'incoming'` accepted; `'Incoming'` -> 400
 *   - PATCH preservation (1.10 -> 2.10): updating with only a subset of fields forwards
 *     ONLY the supplied field to the service (omitted fields are not sent as null).
 *
 * Harness: mirrors `correspondence.integration.test.ts` exactly — a minimal Express app
 * with a mocked `CorrespondenceService` + `AuthService`, the same `authenticate` /
 * `authorize` stubs, and the real `createCorrespondenceRoutes` mounted behind
 * `globalErrorHandler`. A 200 therefore proves the request passed route-level
 * validation/authorization; a 400 proves a schema/param rejection; and a 404 proves a
 * service-thrown `NotFoundError` is surfaced as the documented HTTP status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@alsaqi/shared';
import { globalErrorHandler } from '../../middleware/error';
import { NotFoundError } from '../../utils/errors';

// Full mock surface for CorrespondenceService (every method the router can call), so an
// unmocked method never leaks into the real service. Defaults are happy-path resolves;
// individual tests override with mockRejectedValueOnce(new NotFoundError(...)) to drive 404s.
const mockCorrespondenceService = {
  getIncoming: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  createIncoming: vi.fn().mockResolvedValue({ id: 'inc-1', sequence_number: 'INC-25-001' }),
  updateIncoming: vi.fn().mockResolvedValue(undefined),
  deleteIncoming: vi.fn().mockResolvedValue(undefined),
  updateStatus: vi.fn().mockResolvedValue({ oldStatus: 'Received', newStatus: 'Under Review' }),
  refer: vi.fn().mockResolvedValue(undefined),
  link: vi.fn().mockResolvedValue(undefined),
  archive: vi.fn().mockResolvedValue(undefined),
  getArchive: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, pageSize: 20, total: 0 } }),
  getAttachments: vi.fn().mockResolvedValue([]),
  addAttachment: vi.fn().mockResolvedValue(undefined),
  getDetails: vi.fn().mockResolvedValue({ main: {}, attachments: [], history: [], links: [], referrals: [] }),
  getStats: vi.fn().mockResolvedValue({ incoming: 0, outgoing: 0, archived: 0 }),
  getOutgoing: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  createOutgoing: vi.fn().mockResolvedValue({ id: 'out-1', sequence_number: 'OUT-25-001' }),
  updateOutgoing: vi.fn().mockResolvedValue(undefined),
  deleteOutgoing: vi.fn().mockResolvedValue(undefined),
};

const mockAuthService = {
  logAudit: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../services/CorrespondenceService', () => ({
  CorrespondenceService: new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        (...args: any[]) => (mockCorrespondenceService as Record<string, any>)[prop]?.(...args),
    }
  ),
}));

vi.mock('../../services/AuthService', () => ({
  AuthService: {
    logAudit: (...args: any[]) => mockAuthService.logAudit(...args),
  },
}));

// Import after the mocks are registered.
import { createCorrespondenceRoutes } from '../correspondence';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const UUID2 = '660e8400-e29b-41d4-a716-446655440000';

function createCorrespondenceTestApp(options?: { authenticatedRole?: string; authenticatedUserId?: string }) {
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

  // Permissive authorize for Admin/Manager (mirrors correspondence.integration.test.ts) so that
  // the assertions isolate validation/404 behavior rather than authorization.
  const authorize = (_module: string, action?: string) => (req: any, res: any, next: any) => {
    const role = req.user?.role;
    if (!role) return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    if (['Admin', 'Manager'].includes(role)) return next();
    if (role === 'Internal Auditor' && action && ['Create', 'Edit'].includes(action)) return next();
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
  };

  const logError = vi.fn();
  const saveFile = vi.fn().mockResolvedValue('/uploads/mock-file.pdf');

  const router = createCorrespondenceRoutes(null, authenticate, authorize, logError, saveFile);
  app.use('/api/correspondence', router);
  app.use(globalErrorHandler);

  return { app };
}

const validIncoming = {
  letter_number: 'LTR-001',
  sender_entity: 'Central Bank',
  subject: 'Subject',
  letter_date: '2025-01-15',
  receipt_date: '2025-01-16',
};

const validAttachment = {
  correspondence_id: UUID,
  correspondence_type: 'incoming',
  file_name: 'document.pdf',
  file_type: 'application/pdf',
  file_data: 'JVBERi0xLjQK',
};

describe('Correspondence route coverage (Task 8.2 — findings 1.8 / 1.10)', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createCorrespondenceTestApp().app;
  });

  // ── 1.8 / 2.8 — out-of-enum values are rejected with 400 ───────────────────────
  describe('Req 2.8 — out-of-enum values are rejected (400)', () => {
    it('POST /incoming rejects an out-of-enum priority', async () => {
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer t')
        .send({ ...validIncoming, priority: 'SuperUrgent' });
      expect(res.status).toBe(400);
      expect(mockCorrespondenceService.createIncoming).not.toHaveBeenCalled();
    });

    it('POST /incoming rejects an out-of-enum classification', async () => {
      const res = await request(app)
        .post('/api/correspondence/incoming')
        .set('Authorization', 'Bearer t')
        .send({ ...validIncoming, classification: 'TopSecretBogus' });
      expect(res.status).toBe(400);
    });

    it('PUT /status/incoming rejects an out-of-enum new_status', async () => {
      const res = await request(app)
        .put(`/api/correspondence/status/incoming/${UUID}`)
        .set('Authorization', 'Bearer t')
        .send({ new_status: 'NotARealStatus' });
      expect(res.status).toBe(400);
      expect(mockCorrespondenceService.updateStatus).not.toHaveBeenCalled();
    });

    it('PUT /status/outgoing rejects a status from the WRONG (incoming) enum', async () => {
      // 'Under Review' is an INCOMING status; the outgoing schema must reject it.
      const res = await request(app)
        .put(`/api/correspondence/status/outgoing/${UUID2}`)
        .set('Authorization', 'Bearer t')
        .send({ new_status: 'Under Review' });
      expect(res.status).toBe(400);
    });

    it('POST /link rejects an out-of-enum link_type', async () => {
      const res = await request(app)
        .post('/api/correspondence/link')
        .set('Authorization', 'Bearer t')
        .send({ incoming_id: UUID, outgoing_id: UUID2, link_type: 'NonsenseLink' });
      expect(res.status).toBe(400);
      expect(mockCorrespondenceService.link).not.toHaveBeenCalled();
    });
  });

  // ── 1.8 / 2.8 — invalid `:type` path param is rejected with 400 ────────────────
  describe('Req 2.8 — invalid :type path param is rejected (400)', () => {
    it('GET /details/bogus/:id rejects an unknown type', async () => {
      const res = await request(app)
        .get(`/api/correspondence/details/bogus/${UUID}`)
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(400);
      expect(mockCorrespondenceService.getDetails).not.toHaveBeenCalled();
    });

    it('GET /attachments/bogus/:id rejects an unknown type', async () => {
      const res = await request(app)
        .get(`/api/correspondence/attachments/bogus/${UUID}`)
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(400);
    });

    it('PUT /status/bogus/:id rejects an unknown type', async () => {
      const res = await request(app)
        .put(`/api/correspondence/status/bogus/${UUID}`)
        .set('Authorization', 'Bearer t')
        .send({ new_status: 'Under Review' });
      expect(res.status).toBe(400);
    });

    it('PUT /archive/bogus/:id rejects an unknown type', async () => {
      const res = await request(app)
        .put(`/api/correspondence/archive/bogus/${UUID}`)
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(400);
      expect(mockCorrespondenceService.archive).not.toHaveBeenCalled();
    });
  });

  // ── 1.8 / 2.8 — malformed `:id` (neither integer nor UUID) is rejected with 400 ─
  describe('Req 2.8 — malformed :id path param is rejected (400)', () => {
    it('PUT /incoming/:id rejects an id that is neither integer nor UUID', async () => {
      const res = await request(app)
        .put('/api/correspondence/incoming/not-a-uuid')
        .set('Authorization', 'Bearer t')
        .send({ subject: 'x' });
      expect(res.status).toBe(400);
      expect(mockCorrespondenceService.updateIncoming).not.toHaveBeenCalled();
    });

    it('DELETE /outgoing/:id rejects a malformed id', async () => {
      const res = await request(app)
        .delete('/api/correspondence/outgoing/@bad-id@')
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(400);
    });

    it('GET /details/incoming/:id rejects a malformed id', async () => {
      const res = await request(app)
        .get('/api/correspondence/details/incoming/12ab')
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(400);
    });

    it('PUT /status/incoming/:id rejects a malformed id', async () => {
      const res = await request(app)
        .put('/api/correspondence/status/incoming/not-a-uuid')
        .set('Authorization', 'Bearer t')
        .send({ new_status: 'Under Review' });
      expect(res.status).toBe(400);
    });

    it('accepts a plain integer id (int-or-UUID refinement, Req 3.3 sanity)', async () => {
      const res = await request(app)
        .put('/api/correspondence/incoming/123')
        .set('Authorization', 'Bearer t')
        .send({ subject: 'x' });
      expect(res.status).toBe(200);
    });
  });

  // ── 1.8 / 2.8 — NEW 404 responses (service NotFoundError -> HTTP 404) ───────────
  describe('Req 2.8 — NotFoundError on missing/soft-deleted rows maps to HTTP 404', () => {
    it('PUT /incoming/:id returns 404 when updateIncoming throws NotFoundError', async () => {
      mockCorrespondenceService.updateIncoming.mockRejectedValueOnce(new NotFoundError('Incoming correspondence record not found'));
      const res = await request(app)
        .put(`/api/correspondence/incoming/${UUID}`)
        .set('Authorization', 'Bearer t')
        .send({ subject: 'Updated' });
      expect(res.status).toBe(404);
    });

    it('PUT /outgoing/:id returns 404 when updateOutgoing throws NotFoundError', async () => {
      mockCorrespondenceService.updateOutgoing.mockRejectedValueOnce(new NotFoundError('Outgoing correspondence record not found'));
      const res = await request(app)
        .put(`/api/correspondence/outgoing/${UUID}`)
        .set('Authorization', 'Bearer t')
        .send({ subject: 'Updated' });
      expect(res.status).toBe(404);
    });

    it('DELETE /incoming/:id returns 404 when deleteIncoming throws NotFoundError', async () => {
      mockCorrespondenceService.deleteIncoming.mockRejectedValueOnce(new NotFoundError('Incoming correspondence record not found'));
      const res = await request(app)
        .delete(`/api/correspondence/incoming/${UUID}`)
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(404);
    });

    it('DELETE /outgoing/:id returns 404 when deleteOutgoing throws NotFoundError', async () => {
      mockCorrespondenceService.deleteOutgoing.mockRejectedValueOnce(new NotFoundError('Outgoing correspondence record not found'));
      const res = await request(app)
        .delete(`/api/correspondence/outgoing/${UUID}`)
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(404);
    });

    it('PUT /status/:type/:id returns 404 when updateStatus throws NotFoundError (soft-deleted row)', async () => {
      mockCorrespondenceService.updateStatus.mockRejectedValueOnce(new NotFoundError('Record not found'));
      const res = await request(app)
        .put(`/api/correspondence/status/incoming/${UUID}`)
        .set('Authorization', 'Bearer t')
        .send({ new_status: 'Under Review' });
      expect(res.status).toBe(404);
    });

    it('PUT /archive/:type/:id returns 404 when archive throws NotFoundError (missing/soft-deleted row)', async () => {
      mockCorrespondenceService.archive.mockRejectedValueOnce(new NotFoundError('Correspondence record not found'));
      const res = await request(app)
        .put(`/api/correspondence/archive/incoming/${UUID}`)
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(404);
    });
  });

  // ── 1.2 / 2.2 — archive `?type` casing (Task 3.2 behavior) ─────────────────────
  describe('Req 2.8 — archive ?type casing', () => {
    it('GET /archive?type=Incoming (capitalized) is rejected with 400', async () => {
      const res = await request(app)
        .get('/api/correspondence/archive?type=Incoming')
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(400);
      expect(mockCorrespondenceService.getArchive).not.toHaveBeenCalled();
    });

    it('GET /archive?type=incoming (lowercase) is accepted with 200', async () => {
      const res = await request(app)
        .get('/api/correspondence/archive?type=incoming')
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(200);
      expect(mockCorrespondenceService.getArchive).toHaveBeenCalled();
    });

    it('GET /archive?type=bogus is rejected with 400', async () => {
      const res = await request(app)
        .get('/api/correspondence/archive?type=bogus')
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(400);
    });

    it('GET /archive with no type is accepted with 200 (combined list)', async () => {
      const res = await request(app)
        .get('/api/correspondence/archive')
        .set('Authorization', 'Bearer t');
      expect(res.status).toBe(200);
    });
  });

  // ── 1.1 / 2.1 — attachment body casing (Task 3.1 behavior) ─────────────────────
  describe('Req 2.8 — attachment body casing', () => {
    it('POST /attachments accepts lowercase correspondence_type "incoming"', async () => {
      const res = await request(app)
        .post('/api/correspondence/attachments')
        .set('Authorization', 'Bearer t')
        .send(validAttachment);
      expect(res.status).toBe(200);
      expect(mockCorrespondenceService.addAttachment).toHaveBeenCalled();
    });

    it('POST /attachments rejects capitalized correspondence_type "Incoming" with 400', async () => {
      const res = await request(app)
        .post('/api/correspondence/attachments')
        .set('Authorization', 'Bearer t')
        .send({ ...validAttachment, correspondence_type: 'Incoming' });
      expect(res.status).toBe(400);
      expect(mockCorrespondenceService.addAttachment).not.toHaveBeenCalled();
    });

    it('POST /attachments rejects a file_type outside the MIME allowlist with 400', async () => {
      const res = await request(app)
        .post('/api/correspondence/attachments')
        .set('Authorization', 'Bearer t')
        .send({ ...validAttachment, file_type: 'application/x-msdownload' });
      expect(res.status).toBe(400);
    });
  });

  // ── 1.10 / 2.10 — PATCH preservation at the route boundary [DECISION: keep PATCH] ─
  describe('Req 2.10 — PATCH preservation: only supplied fields are forwarded (omitted not nulled)', () => {
    it('PUT /incoming/:id with only { subject } forwards ONLY subject to updateIncoming', async () => {
      const res = await request(app)
        .put(`/api/correspondence/incoming/${UUID}`)
        .set('Authorization', 'Bearer t')
        .send({ subject: 'Only the subject changes' });
      expect(res.status).toBe(200);
      expect(mockCorrespondenceService.updateIncoming).toHaveBeenCalledTimes(1);

      const [calledId, calledData] = mockCorrespondenceService.updateIncoming.mock.calls[0];
      expect(calledId).toBe(UUID);
      // PATCH semantics: the omitted fields are absent (NOT present as null) — so the
      // service builds a SET clause for `subject` alone and preserves the rest.
      expect(calledData).toEqual({ subject: 'Only the subject changes' });
      for (const omitted of ['letter_number', 'sender_entity', 'letter_date', 'receipt_date', 'classification', 'priority', 'method']) {
        expect(calledData).not.toHaveProperty(omitted);
      }
    });

    it('PUT /outgoing/:id with only { subject } forwards ONLY subject to updateOutgoing', async () => {
      const res = await request(app)
        .put(`/api/correspondence/outgoing/${UUID}`)
        .set('Authorization', 'Bearer t')
        .send({ subject: 'Only the subject changes' });
      expect(res.status).toBe(200);
      expect(mockCorrespondenceService.updateOutgoing).toHaveBeenCalledTimes(1);

      const [calledId, calledData] = mockCorrespondenceService.updateOutgoing.mock.calls[0];
      expect(calledId).toBe(UUID);
      expect(calledData).toEqual({ subject: 'Only the subject changes' });
      for (const omitted of ['letter_date', 'recipient_entity', 'classification', 'sending_method']) {
        expect(calledData).not.toHaveProperty(omitted);
      }
    });
  });
});
