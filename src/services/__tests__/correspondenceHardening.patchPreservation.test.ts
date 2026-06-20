// @vitest-environment node
/**
 * Spec: correspondence-api-hardening-fixes — Task 8.2: PATCH-semantics ratification (service layer)
 *
 * Finding 1.10 -> 2.10 [DECISION: keep PATCH]. This pins the SQL SET-clause shape produced by
 * `updateOutgoing`/`updateIncoming` so the PATCH contract (omitted fields preserved, NOT
 * overwritten with null) can no longer change silently. It is the runnable, supertest-free
 * counterpart to the route-level PATCH assertions in
 * `routes/__tests__/correspondence.routeCoverage.integration.test.ts`.
 *
 * **Validates: Requirements 1.10, 2.10**
 *
 * The Task-1 file `correspondenceHardening.bugCondition.test.ts` already pins `updateOutgoing`
 * for a single field; this file extends that pin to BOTH update methods and adds a multi-field
 * subset to prove only the supplied columns appear in the SET clause (and bind in order, with the
 * id last). It documents CURRENT behavior and is EXPECTED TO PASS as written.
 *
 * The `db` wrapper is mocked with the same recording mock used by the Task-1/Task-2 service suites
 * so the tests can assert on the SQL/args of the real statements CorrespondenceService runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Recording mock DB (mirrors correspondenceHardening.bugCondition.test.ts) ────
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

// The webhook + winston logger are mocked so the post-update dispatch in update*() is inert.
const { sendEventMock } = vi.hoisted(() => ({ sendEventMock: vi.fn(async () => undefined) }));
vi.mock('../../utils/n8nService', () => ({ N8nService: { sendEvent: sendEventMock } }));
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/logger', () => ({ default: loggerMock }));

import { CorrespondenceService } from '../CorrespondenceService';

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

describe('Task 8.2 — PATCH semantics ratification [DECISION: keep PATCH] (Req 1.10, 2.10)', () => {
  describe('updateOutgoing', () => {
    it('a single supplied field yields a SET clause with ONLY that field (omitted preserved)', async () => {
      reset(null);
      await CorrespondenceService.updateOutgoing(UUID, { subject: 'Only the subject changes' });

      const update = runStatements().find((e) => /UPDATE outgoing_letters SET/.test(e.sql));
      expect(update, 'an UPDATE outgoing_letters should run').toBeTruthy();
      expect(update!.sql).toMatch(/subject\s*=/);
      // Omitted columns must NOT appear in the SET clause (PATCH: preserved, not nulled).
      expect(update!.sql).not.toMatch(/recipient_entity\s*=/);
      expect(update!.sql).not.toMatch(/letter_date\s*=/);
      expect(update!.sql).not.toMatch(/classification\s*=/);
      expect(update!.sql).not.toMatch(/sending_method\s*=/);
      // Binds: the supplied value first, the id last (after the SET values).
      expect(update!.args[0]).toBe('Only the subject changes');
      expect(update!.args[update!.args.length - 1]).toBe(UUID);
    });

    it('a multi-field subset sets ONLY the supplied fields and leaves the rest untouched', async () => {
      reset(null);
      await CorrespondenceService.updateOutgoing(UUID, {
        subject: 'New subject',
        classification: 'Confidential',
      });

      const update = runStatements().find((e) => /UPDATE outgoing_letters SET/.test(e.sql));
      expect(update, 'an UPDATE outgoing_letters should run').toBeTruthy();
      expect(update!.sql).toMatch(/subject\s*=/);
      expect(update!.sql).toMatch(/classification\s*=/);
      // Not supplied -> not in the SET clause.
      expect(update!.sql).not.toMatch(/recipient_entity\s*=/);
      expect(update!.sql).not.toMatch(/letter_date\s*=/);
      expect(update!.sql).not.toMatch(/sending_method\s*=/);
      // The two supplied values bind in field order before the trailing id.
      expect(update!.args).toContain('New subject');
      expect(update!.args).toContain('Confidential');
      expect(update!.args[update!.args.length - 1]).toBe(UUID);
    });
  });

  describe('updateIncoming', () => {
    it('a single supplied field yields a SET clause with ONLY that field (omitted preserved)', async () => {
      reset(null);
      await CorrespondenceService.updateIncoming(UUID, { subject: 'Only the subject changes' });

      const update = runStatements().find((e) => /UPDATE incoming_correspondence SET/.test(e.sql));
      expect(update, 'an UPDATE incoming_correspondence should run').toBeTruthy();
      expect(update!.sql).toMatch(/subject\s*=/);
      // Omitted columns must NOT appear in the SET clause.
      expect(update!.sql).not.toMatch(/letter_number\s*=/);
      expect(update!.sql).not.toMatch(/sender_entity\s*=/);
      expect(update!.sql).not.toMatch(/letter_date\s*=/);
      expect(update!.sql).not.toMatch(/priority\s*=/);
      expect(update!.sql).not.toMatch(/classification\s*=/);
      expect(update!.args[0]).toBe('Only the subject changes');
      expect(update!.args[update!.args.length - 1]).toBe(UUID);
    });

    it('a multi-field subset sets ONLY the supplied fields and leaves the rest untouched', async () => {
      reset(null);
      await CorrespondenceService.updateIncoming(UUID, {
        subject: 'New subject',
        priority: 'High',
      });

      const update = runStatements().find((e) => /UPDATE incoming_correspondence SET/.test(e.sql));
      expect(update, 'an UPDATE incoming_correspondence should run').toBeTruthy();
      expect(update!.sql).toMatch(/subject\s*=/);
      expect(update!.sql).toMatch(/priority\s*=/);
      // Not supplied -> not in the SET clause.
      expect(update!.sql).not.toMatch(/letter_number\s*=/);
      expect(update!.sql).not.toMatch(/sender_entity\s*=/);
      expect(update!.sql).not.toMatch(/notes\s*=/);
      expect(update!.args).toContain('New subject');
      expect(update!.args).toContain('High');
      expect(update!.args[update!.args.length - 1]).toBe(UUID);
    });

    it('an empty update is a no-op (no UPDATE issued, omitted fields fully preserved)', async () => {
      reset(null);
      await CorrespondenceService.updateIncoming(UUID, {});
      const update = runStatements().find((e) => /UPDATE incoming_correspondence SET/.test(e.sql));
      // With nothing supplied there is no SET clause at all — the row is untouched.
      expect(update).toBeUndefined();
    });
  });
});
