// @vitest-environment node
/**
 * Spec: correspondence-api-hardening-fixes — Task 1: Bug-condition exploration tests (service layer)
 *
 * Property 1: Bug Condition — each finding reproduces as a counterexample.
 * Validates: Requirements 1.3, 1.4, 1.9, 1.10
 *
 * These tests encode the EXPECTED (correct) behavior for the service-layer findings and are
 * intended to FAIL on the UNFIXED code — each failure is a counterexample confirming the defect
 * documented in bugfix.md / design.md `isBugCondition(input)`. They MUST NOT be made to pass by
 * editing production code in this task (that is the job of the later fix tasks).
 *
 * EXCEPTION — 1.10 is a [DECISION: keep PATCH] behavior-ratification pin (bugfix.md 2.10): it
 * documents the CURRENT PATCH semantics (omitted fields preserved) and is therefore EXPECTED TO
 * PASS on unfixed code. It exists so the contract can no longer change silently.
 *
 * The `db` wrapper is mocked with a recording mock (mirroring
 * services/__tests__/userManagementFixes.bugCondition.property.test.ts) so the tests can assert on
 * the SQL/args of the statements the real CorrespondenceService runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

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

// Winston logger is mocked so we can assert the webhook-failure log destination (1.9).
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/logger', () => ({ default: loggerMock }));

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reset(null);
  sendEventMock.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Property 1: Bug Condition exploration — CorrespondenceService (correspondence-api-hardening-fixes)', () => {
  // ── 1.3 archive() lacks the deleted_at + result.changes guard ────────────────
  describe('Finding 1.3 — archive() soft-delete + 404 guard (Req 1.3)', () => {
    it('1.3a archive() UPDATE includes a "deleted_at IS NULL" guard', async () => {
      reset(null);
      await CorrespondenceService.archive('incoming', UUID);
      const update = runStatements().find((e) => /UPDATE/.test(e.sql) && /is_archived\s*=\s*1/.test(e.sql));
      expect(update, 'archive() should issue an UPDATE').toBeTruthy();
      // Expected (2.3): a soft-deleted row must not be re-archived.
      // Counterexample on unfixed code: the WHERE is `WHERE id = ?::uuid` with no deleted_at predicate.
      expect(update!.sql).toMatch(/deleted_at IS NULL/);
    });

    it('1.3b archive() throws NotFoundError when no row matches (result.changes === 0)', async () => {
      await fc.assert(
        fc.asyncProperty(fc.uuid(), fc.constantFrom('incoming', 'outgoing'), async (id, type) => {
          reset((sql, method) => {
            if (method === 'run' && /is_archived\s*=\s*1/.test(sql)) return { changes: 0, lastInsertRowid: 0 };
            return undefined;
          });
          // Expected (2.3): archiving a missing/soft-deleted id is a 404 (NotFoundError).
          // Counterexample on unfixed code: archive() ignores result.changes and resolves (=> HTTP 200).
          await expect(CorrespondenceService.archive(type, id)).rejects.toBeInstanceOf(NotFoundError);
        }),
        { numRuns: 20 },
      );
    });
  });

  // ── 1.4 updateStatus() omits deleted_at IS NULL on SELECT and UPDATE ─────────
  describe('Finding 1.4 — updateStatus() soft-delete guard (Req 1.4)', () => {
    it('1.4a updateStatus() SELECT and UPDATE both include "deleted_at IS NULL"', async () => {
      reset((sql, method) => {
        if (method === 'get' && /SELECT status FROM/.test(sql)) return { status: 'Received' };
        return undefined;
      });
      await CorrespondenceService.updateStatus('incoming', UUID, 'Under Review', '', UUID);
      const select = dbState.log.find((e) => e.method === 'get' && /SELECT status FROM/.test(e.sql));
      const update = dbState.log.find((e) => e.method === 'run' && /UPDATE/.test(e.sql) && /SET status/.test(e.sql));
      expect(select, 'a status SELECT should run').toBeTruthy();
      expect(update, 'a status UPDATE should run').toBeTruthy();
      // Expected (2.4): both statements must exclude soft-deleted rows.
      // Counterexample on unfixed code: neither statement carries a deleted_at predicate.
      expect(select!.sql).toMatch(/deleted_at IS NULL/);
      expect(update!.sql).toMatch(/deleted_at IS NULL/);
    });

    it('1.4b updateStatus() throws NotFoundError for a soft-deleted row', async () => {
      await fc.assert(
        fc.asyncProperty(fc.uuid(), fc.constantFrom('incoming', 'outgoing'), async (id, type) => {
          reset((sql, method) => {
            // Model a soft-deleted row: visible to the UNGUARDED SELECT, absent to a guarded one.
            if (method === 'get' && /SELECT status FROM/.test(sql)) {
              return /deleted_at IS NULL/.test(sql) ? null : { status: 'Received' };
            }
            return undefined;
          });
          const newStatus = type === 'outgoing' ? 'Sent' : 'Under Review';
          // Expected (2.4): a soft-deleted record is treated as not found.
          // Counterexample on unfixed code: the SELECT finds the soft-deleted row and the UPDATE succeeds.
          await expect(
            CorrespondenceService.updateStatus(type, id, newStatus, '', id),
          ).rejects.toBeInstanceOf(NotFoundError);
        }),
        { numRuns: 20 },
      );
    });
  });

  // ── 1.9 webhook failures logged via console.error instead of winston ─────────
  describe('Finding 1.9 — webhook failures use the winston logger (Req 1.9)', () => {
    it('1.9 a failed webhook dispatch is logged via logger.error (not console.error)', async () => {
      reset(null);
      sendEventMock.mockRejectedValueOnce(new Error('n8n unreachable'));
      // updateOutgoing performs the committed UPDATE, then dispatches the webhook in a try/catch.
      await CorrespondenceService.updateOutgoing(UUID, { subject: 'New subject' });
      // Expected (2.9): the failure is recorded through the structured winston logger.
      // Counterexample on unfixed code: the catch uses console.error('[Automation Error] ...'),
      // so the winston logger is never invoked.
      expect(loggerMock.error).toHaveBeenCalled();
    });
  });

  // ── 1.10 PATCH semantics — ratification pin (EXPECTED TO PASS) ───────────────
  describe('Finding 1.10 — PATCH semantics preserved [DECISION: keep PATCH] (Req 1.10)', () => {
    // NOTE: This documents CURRENT behavior (bugfix.md 2.10 recommends keeping PATCH) and is
    // EXPECTED TO PASS on unfixed code — it pins the contract so it cannot change silently.
    it('1.10 updateOutgoing() only sets supplied fields (omitted fields preserved, not nulled)', async () => {
      reset(null);
      await CorrespondenceService.updateOutgoing(UUID, { subject: 'Only the subject changes' });
      const update = runStatements().find((e) => /UPDATE outgoing_letters SET/.test(e.sql));
      expect(update, 'an UPDATE should run').toBeTruthy();
      expect(update!.sql).toMatch(/subject\s*=/);
      // Omitted fields must NOT appear in the SET clause (PATCH: preserved, not overwritten with null).
      expect(update!.sql).not.toMatch(/recipient_entity\s*=/);
      expect(update!.sql).not.toMatch(/letter_date\s*=/);
      expect(update!.sql).not.toMatch(/classification\s*=/);
      expect(update!.sql).not.toMatch(/sending_method\s*=/);
    });
  });
});
