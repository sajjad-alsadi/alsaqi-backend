// @vitest-environment node
/**
 * Spec: correspondence-api-hardening-fixes — Task 2: Preservation property tests (service layer)
 *
 * Property 2: Preservation — for every input where NO bug condition holds (¬C(X)), the fixed
 * code must behave identically to the current code. These tests RECORD the current correct
 * baseline on the UNFIXED code and are therefore EXPECTED TO PASS as written. They must NOT be
 * coupled to any gated [DECISION] behavior (e.g. the 1.1 attachment-casing change): where a
 * finding overlaps a preserved behavior, the assertion captures only the part that genuinely
 * does not change (a valid attachment still persists and is readable; in-range pagination still
 * returns the same set and ordering, etc.).
 *
 * Validates: Requirements 3.4, 3.5, 3.6, 3.7
 *
 * The `db` wrapper is mocked with a recording mock (mirroring the Task-1
 * correspondenceHardening.bugCondition.test.ts harness) so the tests can assert on the SQL/args
 * of the statements the real CorrespondenceService runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { MAX_PAGE_SIZE } from '../../utils/paginationService';

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

// n8n webhook dispatch is mocked so we control success/failure per test.
const { sendEventMock } = vi.hoisted(() => ({ sendEventMock: vi.fn(async () => undefined) }));
vi.mock('../../utils/n8nService', () => ({ N8nService: { sendEvent: sendEventMock } }));

// Winston logger is mocked (harmless) so any current console.* vs logger.* destination does not
// affect these tests — preservation here is about dispatch + isolation, NOT the log destination.
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/logger', () => ({ default: loggerMock }));

// NumberingService is mocked so create* paths produce a deterministic sequence number without
// needing DB-backed counter rows (not exercised by these preservation tests directly).
vi.mock('../NumberingService', () => ({
  NumberingService: { nextCounter: vi.fn(async () => 1) },
}));

import { CorrespondenceService } from '../CorrespondenceService';
import { NotFoundError } from '../../utils/errors';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

function reset(responder: ((sql: string, method: string, args: any[]) => any) | null = null) {
  dbState.log = [];
  dbState.responder = responder;
}
function runStatements() {
  return dbState.log.filter((e) => e.method === 'run');
}
/** The single paginated data query (`... LIMIT ? OFFSET ?`) issued by a list/archive call. */
function paginatedDataCall() {
  return dbState.log.find((e) => e.method === 'all' && /LIMIT \? OFFSET \?/.test(e.sql));
}

// Generates an id from the accepted id family (integer OR UUID) — see Req 3.3.
const idArb = fc.oneof(fc.nat({ max: 2 ** 31 }).map((n) => String(n)), fc.uuid());

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reset(null);
  sendEventMock.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Property 2: Preservation — CorrespondenceService (correspondence-api-hardening-fixes)', () => {
  // ── 3.4 Successful webhook dispatch after commit + try/catch isolation ───────
  describe('Req 3.4 — webhook dispatch after commit and failure isolation', () => {
    it('3.4a a successful webhook is dispatched AFTER the committed DB write', async () => {
      reset(null); // every run resolves with { changes: 1 }
      let logAtDispatch: Array<{ sql: string; method: string }> = [];
      sendEventMock.mockImplementationOnce(async () => {
        logAtDispatch = dbState.log.map((e) => ({ sql: e.sql, method: e.method }));
      });

      await CorrespondenceService.updateOutgoing(UUID, { subject: 'New subject' });

      // The webhook fired exactly once with the documented event name.
      expect(sendEventMock).toHaveBeenCalledTimes(1);
      expect(sendEventMock.mock.calls[0][0]).toBe('outgoing_correspondence.updated');
      // At dispatch time the UPDATE had already run → dispatch happens after commit (3.4 / 3.6).
      const updateBeforeDispatch = logAtDispatch.some(
        (e) => e.method === 'run' && /UPDATE outgoing_letters SET/.test(e.sql),
      );
      expect(updateBeforeDispatch, 'UPDATE must be committed before the webhook dispatch').toBe(true);
    });

    it('3.4b a failing webhook is isolated — the committed write is not rolled back and no error propagates', async () => {
      reset(null);
      sendEventMock.mockRejectedValueOnce(new Error('n8n unreachable'));

      // try/catch isolation: a webhook failure must NOT surface to the caller.
      await expect(CorrespondenceService.updateOutgoing(UUID, { subject: 'Subj' })).resolves.toBeUndefined();

      // The committed UPDATE still ran (it is not rolled back by the webhook failure).
      const update = runStatements().find((e) => /UPDATE outgoing_letters SET/.test(e.sql));
      expect(update, 'the UPDATE must have run and remain committed').toBeTruthy();
    });
  });

  // ── 3.5 Existing update/delete NotFoundError on missing rows (already correct) ─
  describe('Req 3.5 — update/delete throw NotFoundError when no row matches', () => {
    it('3.5a updateOutgoing / updateIncoming throw NotFoundError when result.changes === 0', async () => {
      await fc.assert(
        fc.asyncProperty(idArb, async (id) => {
          // Model a missing/already-deleted row: the guarded UPDATE matches nothing.
          reset((sql, method) =>
            method === 'run' && /UPDATE (outgoing_letters|incoming_correspondence) SET/.test(sql)
              ? { changes: 0, lastInsertRowid: 0 }
              : undefined,
          );
          await expect(CorrespondenceService.updateOutgoing(id, { subject: 'x' })).rejects.toBeInstanceOf(
            NotFoundError,
          );

          reset((sql, method) =>
            method === 'run' && /UPDATE (outgoing_letters|incoming_correspondence) SET/.test(sql)
              ? { changes: 0, lastInsertRowid: 0 }
              : undefined,
          );
          await expect(CorrespondenceService.updateIncoming(id, { subject: 'x' })).rejects.toBeInstanceOf(
            NotFoundError,
          );
        }),
        { numRuns: 30 },
      );
    });

    it('3.5b deleteOutgoing / deleteIncoming throw NotFoundError when no row matches', async () => {
      await fc.assert(
        fc.asyncProperty(idArb, async (id) => {
          // deleteOutgoing: the soft-delete UPDATE matches nothing.
          reset((sql, method) =>
            method === 'run' && /UPDATE outgoing_letters SET deleted_at/.test(sql)
              ? { changes: 0, lastInsertRowid: 0 }
              : undefined,
          );
          await expect(CorrespondenceService.deleteOutgoing(id)).rejects.toBeInstanceOf(NotFoundError);

          // deleteIncoming: the parent soft-delete UPDATE matches nothing (attachments default ok).
          reset((sql, method) =>
            method === 'run' && /UPDATE incoming_correspondence SET deleted_at/.test(sql)
              ? { changes: 0, lastInsertRowid: 0 }
              : undefined,
          );
          await expect(CorrespondenceService.deleteIncoming(id)).rejects.toBeInstanceOf(NotFoundError);
        }),
        { numRuns: 30 },
      );
    });
  });

  // ── 3.6 In-range archive/list result sets + ordering (modulo the new clamp) ───
  describe('Req 3.6 — in-range list/archive queries return the same set and ordering', () => {
    const ROWS = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
    const TOTAL = 137;
    // In-range family: page >= 1, pageSize within the shared clamp (<= MAX_PAGE_SIZE), so the
    // soon-to-be-applied clamp/normalization does not change the effective LIMIT/OFFSET.
    const inRange = fc.record({
      page: fc.integer({ min: 1, max: 50 }),
      pageSize: fc.integer({ min: 1, max: MAX_PAGE_SIZE }),
    });
    const listResponder = (sql: string, method: string) => {
      if (method === 'get' && /COUNT\(\*\)/.test(sql)) return { total: TOTAL };
      if (method === 'all') return ROWS;
      return undefined;
    };

    it('3.6a getArchive (combined) preserves data passthrough, DESC ordering, and in-range LIMIT/OFFSET', async () => {
      await fc.assert(
        fc.asyncProperty(inRange, async ({ page, pageSize }) => {
          reset(listResponder);
          const result = await CorrespondenceService.getArchive({ page, pageSize });

          const data = paginatedDataCall();
          expect(data, 'a paginated data query should run').toBeTruthy();
          expect(data!.sql).toMatch(/ORDER BY updated_at DESC/);
          // In-range: LIMIT = pageSize, OFFSET = (page-1)*pageSize (the last two bind params).
          expect(Number(data!.args[data!.args.length - 2])).toBe(pageSize);
          expect(Number(data!.args[data!.args.length - 1])).toBe((page - 1) * pageSize);
          // Result set + ordering are an unchanged passthrough of what the DB returned.
          expect(result.data).toEqual(ROWS);
          expect(result.pagination.page).toBe(page);
          expect(result.pagination.pageSize).toBe(pageSize);
          expect(result.pagination.total).toBe(TOTAL);
        }),
        { numRuns: 40 },
      );
    });

    it('3.6b getArchive (single type) preserves DESC ordering and in-range LIMIT/OFFSET', async () => {
      await fc.assert(
        fc.asyncProperty(inRange, fc.constantFrom('incoming', 'outgoing'), async ({ page, pageSize }, type) => {
          reset(listResponder);
          const result = await CorrespondenceService.getArchive({ type, page, pageSize });

          const data = paginatedDataCall();
          expect(data, 'a paginated data query should run').toBeTruthy();
          expect(data!.sql).toMatch(/ORDER BY updated_at DESC/);
          expect(Number(data!.args[data!.args.length - 2])).toBe(pageSize);
          expect(Number(data!.args[data!.args.length - 1])).toBe((page - 1) * pageSize);
          expect(result.data).toEqual(ROWS);
          expect(result.pagination.total).toBe(TOTAL);
        }),
        { numRuns: 40 },
      );
    });

    it('3.6c getOutgoing preserves data passthrough, DESC ordering, and in-range LIMIT/OFFSET', async () => {
      await fc.assert(
        fc.asyncProperty(inRange, async ({ page, pageSize }) => {
          reset(listResponder);
          const result = await CorrespondenceService.getOutgoing(page, pageSize);

          const data = paginatedDataCall();
          expect(data, 'a paginated data query should run').toBeTruthy();
          expect(data!.sql).toMatch(/FROM outgoing_letters/);
          expect(data!.sql).toMatch(/ORDER BY created_at DESC/);
          expect(Number(data!.args[data!.args.length - 2])).toBe(pageSize);
          expect(Number(data!.args[data!.args.length - 1])).toBe((page - 1) * pageSize);
          expect(result.data).toEqual(ROWS);
          expect(result.pagination.total).toBe(TOTAL);
        }),
        { numRuns: 40 },
      );
    });
  });

  // ── 3.7 Valid attachment persistence (readable by getAttachments) ────────────
  describe('Req 3.7 — a valid attachment persists and is readable', () => {
    it('3.7a addAttachment persists the attachment columns (correspondence_id + file_name/file_type/file_data)', async () => {
      reset(null);
      const attachment = {
        correspondence_id: UUID,
        correspondence_type: 'Incoming', // valid under the CURRENT schema; casing reconciliation is gated (1.1)
        file_name: 'document.pdf',
        file_type: 'application/pdf',
        file_data: 'JVBERi0xLjQK',
        description: 'A valid attachment',
      };
      await CorrespondenceService.addAttachment(attachment, UUID);

      const insert = runStatements().find((e) => /INSERT INTO correspondence_attachments/.test(e.sql));
      expect(insert, 'an attachment INSERT should run').toBeTruthy();
      // The genuinely-unchanging part: the persisted columns/values round-trip into the insert.
      expect(insert!.args).toContain(UUID); // correspondence_id (and uploaded_by)
      expect(insert!.args).toContain('document.pdf'); // file_name
      expect(insert!.args).toContain('application/pdf'); // file_type (persisted MIME column)
      expect(insert!.args).toContain('JVBERi0xLjQK'); // file_data (persisted column)
    });

    it('3.7b getAttachments reads attachments back via the (type → DB-type) mapping', async () => {
      const STORED = [
        { id: 'att-1', file_name: 'a.pdf', file_type: 'application/pdf', uploaded_at: 'now', description: null },
      ];
      reset((sql, method) =>
        method === 'all' && /FROM correspondence_attachments/.test(sql) ? STORED : undefined,
      );

      const incoming = await CorrespondenceService.getAttachments('incoming', UUID);
      expect(incoming).toEqual(STORED);
      const sel = dbState.log.find((e) => e.method === 'all' && /FROM correspondence_attachments/.test(e.sql));
      expect(sel, 'a SELECT against correspondence_attachments should run').toBeTruthy();
      // Edge-lowercase 'incoming' is mapped to the stored capitalized 'Incoming' + the id (preserved).
      expect(sel!.args).toContain('Incoming');
      expect(sel!.args).toContain(UUID);

      reset((sql, method) =>
        method === 'all' && /FROM correspondence_attachments/.test(sql) ? STORED : undefined,
      );
      await CorrespondenceService.getAttachments('outgoing', UUID);
      const selOut = dbState.log.find((e) => e.method === 'all' && /FROM correspondence_attachments/.test(e.sql));
      expect(selOut!.args).toContain('Outgoing');
    });
  });
});
