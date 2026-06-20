// @vitest-environment node
/**
 * Spec: correspondence-api-hardening-fixes — Task 1: Bug-condition exploration tests (route + schema layer)
 *
 * Property 1: Bug Condition — findings 1.1, 1.2, 1.5, 1.7, 1.8 reproduce as counterexamples.
 * Validates: Requirements 1.1, 1.2, 1.5, 1.7, 1.8
 *
 * These encode the EXPECTED (correct) behavior and are intended to FAIL on the UNFIXED code — each
 * failure is a counterexample confirming the documented defect. They MUST NOT be made to pass by
 * editing production code in this task.
 *
 * For the route-level findings (1.2 / 1.5 / 1.8) the REAL CorrespondenceService is exercised
 * end-to-end against a recording mock `db`, so the route -> service -> SQL path is what is under
 * test. AuthService (audit logging only) and the n8n webhook are mocked.
 *
 * 1.1 is [DECISION: lowercase-at-edge] (bugfix.md 2.1); the recommended contract is encoded here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { globalErrorHandler } from '../../middleware/error';
import { MAX_PAGE_SIZE } from '../../utils/paginationService';

// ─── Recording mock DB (for the route end-to-end findings) ──────────────────────
const { dbState } = vi.hoisted(() => ({
  dbState: {
    log: [] as Array<{ sql: string; method: 'get' | 'all' | 'run'; args: any[] }>,
    responder: null as null | ((sql: string, method: string, args: any[]) => any),
  },
}));

vi.mock('../../db/index', () => {
  const db = {
    isExternal: false,
    validateIdentifier: (id: string) => id,
    prepare(sql: string) {
      const exec = (method: 'get' | 'all' | 'run') => async (...args: any[]) => {
        dbState.log.push({ sql, method, args });
        const r = dbState.responder ? dbState.responder(sql, method, args) : undefined;
        if (r !== undefined) return r;
        return method === 'all' ? [] : method === 'get' ? null : { changes: 1, lastInsertRowid: 0 };
      };
      return { get: exec('get'), all: exec('all'), run: exec('run') };
    },
    async transaction(fn: () => any) {
      return fn();
    },
  };
  return { db };
});

vi.mock('../../services/AuthService', () => ({ AuthService: { logAudit: vi.fn(async () => undefined) } }));
vi.mock('../../utils/n8nService', () => ({ N8nService: { sendEvent: vi.fn(async () => undefined) } }));

import { createCorrespondenceRoutes } from '../correspondence';
import * as correspondenceModule from '../correspondence';
import { correspondenceAttachmentSchema } from '../../schemas';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

function buildApp() {
  const app = express();
  app.use(express.json());
  const authenticate = (req: any, _res: any, next: any) => {
    req.user = { id: UUID, role: 'Admin', username: 'tester', name: 'Tester', email: 't@example.com' };
    next();
  };
  const checkPermission = () => (_req: any, _res: any, next: any) => next();
  const router = createCorrespondenceRoutes(null, authenticate, checkPermission, vi.fn(), vi.fn());
  app.use('/api/correspondence', router);
  app.use(globalErrorHandler);
  return app;
}

function reset(responder: ((sql: string, method: string, args: any[]) => any) | null = null) {
  dbState.log = [];
  dbState.responder = responder;
}

beforeEach(() => {
  vi.clearAllMocks();
  reset(null);
});

// ── 1.1 Attachment schema: casing + persisted-column validation [DECISION] ──────
describe('Finding 1.1 — attachment schema casing + persisted columns (Req 1.1) [DECISION: lowercase]', () => {
  it('1.1a accepts a lowercase correspondence_type (matching the lowercase path params)', () => {
    const body = {
      correspondence_id: UUID,
      correspondence_type: 'incoming', // lowercase at the edge (recommended, 2.1)
      file_name: 'document.pdf',
      file_type: 'application/pdf', // persisted column (MIME), validated against the allowlist
      file_data: 'JVBERi0xLjQK', // persisted column
    };
    const result = correspondenceAttachmentSchema.safeParse(body);
    // Expected (2.1): lowercase is accepted and the persisted-field contract validates.
    // Counterexample on unfixed code: the enum is ['Incoming','Outgoing'] (lowercase rejected) and
    // the schema requires file_size + mime_type (which are not the persisted columns).
    expect(result.success).toBe(true);
  });

  it('1.1b validates the persisted file_type column against the MIME allowlist', () => {
    const body = {
      correspondence_id: UUID,
      correspondence_type: 'Incoming', // valid under the CURRENT (capitalized) schema
      file_name: 'document.pdf',
      file_size: 1024,
      mime_type: 'application/pdf',
      file_type: 'application/x-msdownload', // the ACTUALLY-persisted column; not an allowed MIME
      file_data: 'AAAA',
    };
    const result = correspondenceAttachmentSchema.safeParse(body);
    // Expected (2.1): the persisted file_type must be validated (no silent passthrough of a bad MIME).
    // Counterexample on unfixed code: file_type/file_data are not in the schema, so they are stripped
    // and the body is accepted despite an invalid persisted MIME type.
    expect(result.success).toBe(false);
  });
});

// ── 1.7 Real route schemas are exported (so the schema-sync test can import them) ─
describe('Finding 1.7 — route schemas are exported for the schema-sync test (Req 1.7)', () => {
  const expectedExports = [
    'incomingSchema',
    'outgoingSchema',
    'linkSchema',
    'incomingStatusUpdateSchema',
    'outgoingStatusUpdateSchema',
  ];
  for (const name of expectedExports) {
    it(`1.7 exports ${name} from src/routes/correspondence.ts`, () => {
      const exported = (correspondenceModule as Record<string, any>)[name];
      // Expected (2.7): the schema-sync test must import the REAL schema, so it must be exported.
      // Counterexample on unfixed code: these are module-local consts and are not exported.
      expect(exported, `${name} should be exported from the route module`).toBeDefined();
      expect(typeof exported?.safeParse, `${name} should be a Zod schema`).toBe('function');
    });
  }
});

// ── 1.2 GET /archive validates the `type` query ─────────────────────────────────
describe('Finding 1.2 — GET /archive validates the type query (Req 1.2)', () => {
  it('1.2 rejects a capitalized ?type=Incoming with 400 (no silent fall-through to combined)', async () => {
    reset((sql, method) => {
      if (method === 'get' && /COUNT\(\*\)/.test(sql)) return { total: 0 };
      return undefined;
    });
    const app = buildApp();
    const res = await request(app)
      .get('/api/correspondence/archive?type=Incoming')
      .set('Authorization', 'Bearer t');
    // Expected (2.2): an out-of-set (capitalized) type is a deterministic 400.
    // Counterexample on unfixed code: the route has no validateQuery and getArchive silently
    // returns the combined incoming+outgoing set with HTTP 200.
    expect(res.status).toBe(400);
  });
});

// ── 1.5 GET /archive bounds pageSize via the shared clamp ───────────────────────
describe('Finding 1.5 — GET /archive bounds pageSize via the shared clamp (Req 1.5)', () => {
  it('1.5 a huge pageSize does not become an unbounded SQL LIMIT', async () => {
    reset((sql, method) => {
      if (method === 'get' && /COUNT\(\*\)/.test(sql)) return { total: 0 };
      return undefined;
    });
    const app = buildApp();
    const res = await request(app)
      .get('/api/correspondence/archive?pageSize=100000000')
      .set('Authorization', 'Bearer t');
    expect(res.status).toBe(200);
    // The combined-branch data query carries the effective LIMIT as its second-to-last bind param.
    const dataCall = dbState.log.find((e) => e.method === 'all' && /LIMIT \? OFFSET \?/.test(e.sql));
    expect(dataCall, 'a paginated archive query should run').toBeTruthy();
    const limit = Number(dataCall!.args[dataCall!.args.length - 2]);
    // Expected (2.5): the effective LIMIT is clamped to the shared maximum page size.
    // Counterexample on unfixed code: getArchive uses `Number(pageSize) || 15`, so the literal
    // LIMIT becomes 100000000 (unbounded result set / DoS lever).
    expect(limit).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });
});

// ── 1.8 Route-level 404 coverage for missing / soft-deleted rows ────────────────
describe('Finding 1.8 — route-level 404 coverage for missing/soft-deleted rows (Req 1.8)', () => {
  it('1.8a PUT /archive/:type/:id returns 404 when the row does not exist', async () => {
    reset((sql, method) => {
      if (method === 'run' && /is_archived\s*=\s*1/.test(sql)) return { changes: 0, lastInsertRowid: 0 };
      return undefined;
    });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/correspondence/archive/incoming/${UUID}`)
      .set('Authorization', 'Bearer t');
    // Expected (2.3 / 2.8): archiving a missing id is a 404, not 200.
    // Counterexample on unfixed code: archive() never checks result.changes, so the route returns 200.
    expect(res.status).toBe(404);
  });

  it('1.8b PUT /status/:type/:id returns 404 for a soft-deleted row', async () => {
    reset((sql, method) => {
      // Model a soft-deleted row: visible to the UNGUARDED SELECT, absent to a guarded one.
      if (method === 'get' && /SELECT status FROM/.test(sql)) {
        return /deleted_at IS NULL/.test(sql) ? null : { status: 'Received' };
      }
      return undefined;
    });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/correspondence/status/incoming/${UUID}`)
      .set('Authorization', 'Bearer t')
      .send({ new_status: 'Under Review' });
    // Expected (2.4 / 2.8): a status change on a soft-deleted row is a 404.
    // Counterexample on unfixed code: the SELECT omits deleted_at IS NULL, finds the row, and the
    // status change succeeds with HTTP 200.
    expect(res.status).toBe(404);
  });
});
