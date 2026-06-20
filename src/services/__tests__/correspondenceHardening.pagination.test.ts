// @vitest-environment node
/**
 * Spec: correspondence-api-hardening-fixes — Task 5: Cluster C pagination safety (finding 1.5 -> 2.5)
 *
 * Finding 1.5: GET /archive did not route through the shared pagination clamp, and getArchive's
 * combined branch re-derived an UNBOUNDED `Number(pageSize) || 15`, so `?pageSize=100000000` became
 * a literal `LIMIT 100000000` (a DoS lever).
 *
 * The route-level reproduction (routes/__tests__/correspondence.hardening.bugCondition.test.ts,
 * finding 1.5) is supertest-based and cannot run in this sandbox (sockets are blocked). This file
 * verifies the SAME fix at the RUNNABLE service layer, in two composable parts that together mirror
 * exactly what the GET /archive handler now does:
 *   (a) parsePaginationParams clamps a huge pageSize to MAX_PAGE_SIZE (the edge clamp), and
 *   (b) getArchive faithfully emits the page/pageSize it is passed as the SQL LIMIT/OFFSET across
 *       ALL THREE branches (combined, incoming, outgoing) — so once the route clamps, the effective
 *       LIMIT is always bounded.
 *
 * Validates: Requirements 1.5, 2.5 (and 3.6 in-range faithfulness)
 *
 * The `db` wrapper is mocked with the same recording mock used by the Task-2 preservation suite so
 * we can assert on the SQL/args of the statements the real CorrespondenceService runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parsePaginationParams, MAX_PAGE_SIZE } from '../../utils/paginationService';

// ─── Recording mock DB ──────────────────────────────────────────────────────────
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

// These mocks keep the service self-contained (not exercised by these tests, but imported by it).
vi.mock('../../utils/n8nService', () => ({ N8nService: { sendEvent: vi.fn(async () => undefined) } }));
vi.mock('../../utils/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../NumberingService', () => ({ NumberingService: { nextCounter: vi.fn(async () => 1) } }));

import { CorrespondenceService } from '../CorrespondenceService';

const TOTAL = 137;

function reset(responder: ((sql: string, method: string, args: any[]) => any) | null = null) {
  dbState.log = [];
  dbState.responder = responder;
}
/** The single paginated data query (`... LIMIT ? OFFSET ?`) issued by an archive call. */
function paginatedDataCall() {
  return dbState.log.find((e) => e.method === 'all' && /LIMIT \? OFFSET \?/.test(e.sql));
}
const listResponder = (sql: string, method: string) => {
  if (method === 'get' && /COUNT\(\*\)/.test(sql)) return { total: TOTAL };
  if (method === 'all') return [{ id: 'r1' }, { id: 'r2' }];
  return undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  reset(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cluster C — GET /archive pagination safety (finding 1.5 -> 2.5)', () => {
  // ── (a) The shared edge clamp ───────────────────────────────────────────────
  describe('parsePaginationParams clamps pageSize to the shared maximum (the edge clamp, 2.5)', () => {
    it('caps a huge pageSize at MAX_PAGE_SIZE (100)', () => {
      expect(parsePaginationParams({ pageSize: '100000000' }).pageSize).toBe(MAX_PAGE_SIZE);
      expect(parsePaginationParams({ pageSize: '100000000' }).pageSize).toBe(100);
    });
    it('leaves an in-range pageSize unchanged and computes the offset', () => {
      expect(parsePaginationParams({ page: '2', pageSize: '50' })).toMatchObject({
        page: 2,
        pageSize: 50,
        offset: 50,
      });
    });
    it('defaults a missing pageSize (note: 20, vs getArchive’s own historical 15 fallback)', () => {
      expect(parsePaginationParams({}).pageSize).toBe(20);
      expect(parsePaginationParams({}).page).toBe(1);
    });
  });

  // ── (b) getArchive faithfully uses the page/pageSize it is passed ────────────
  describe('getArchive emits the passed page/pageSize as the SQL LIMIT/OFFSET across all branches', () => {
    it('combined branch: LIMIT = pageSize, OFFSET = (page-1)*pageSize', async () => {
      reset(listResponder);
      await CorrespondenceService.getArchive({ page: 2, pageSize: MAX_PAGE_SIZE });
      const data = paginatedDataCall();
      expect(data, 'a paginated archive query should run').toBeTruthy();
      // The last two bind params are LIMIT then OFFSET.
      expect(Number(data!.args[data!.args.length - 2])).toBe(MAX_PAGE_SIZE);
      expect(Number(data!.args[data!.args.length - 1])).toBe((2 - 1) * MAX_PAGE_SIZE);
    });

    for (const type of ['incoming', 'outgoing'] as const) {
      it(`single-type (${type}) branch: LIMIT = pageSize, OFFSET = 0 on page 1`, async () => {
        reset(listResponder);
        await CorrespondenceService.getArchive({ type, page: 1, pageSize: MAX_PAGE_SIZE });
        const data = paginatedDataCall();
        expect(data, 'a paginated archive query should run').toBeTruthy();
        expect(Number(data!.args[data!.args.length - 2])).toBe(MAX_PAGE_SIZE);
        expect(Number(data!.args[data!.args.length - 1])).toBe(0);
      });
    }
  });

  // ── (a)+(b) Route-equivalent composition WITHOUT supertest ───────────────────
  // The GET /archive handler does `parsePaginationParams(req.query)` then
  // `getArchive({ ...req.query, page, pageSize })`. Replicating that here proves a huge
  // `?pageSize` can never become an unbounded SQL LIMIT — the runnable stand-in for the
  // socket-blocked route test (finding 1.5).
  describe('route-equivalent composition: a huge pageSize is bounded end-to-end (1.5 -> 2.5)', () => {
    for (const type of [undefined, 'incoming', 'outgoing'] as const) {
      const label = type ?? 'combined';
      it(`pageSize=100000000 -> effective LIMIT <= MAX_PAGE_SIZE (type=${label})`, async () => {
        reset(listResponder);
        // Exactly what the route handler now does:
        const { page, pageSize } = parsePaginationParams({ pageSize: '100000000' });
        await CorrespondenceService.getArchive({ ...(type ? { type } : {}), page, pageSize });
        const data = paginatedDataCall();
        expect(data, 'a paginated archive query should run').toBeTruthy();
        const limit = Number(data!.args[data!.args.length - 2]);
        expect(limit).toBeLessThanOrEqual(MAX_PAGE_SIZE);
        expect(limit).toBe(MAX_PAGE_SIZE);
      });
    }
  });
});
