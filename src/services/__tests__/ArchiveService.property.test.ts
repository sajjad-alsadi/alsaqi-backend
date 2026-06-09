// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for ArchiveService (Properties 1 & 15)
 *
 * Feature: audit-modules-restructure
 *
 * Property 1: Archived plans are immutable
 * Property 15: Archive separation (data moved to archive tables)
 *
 * **Validates: Requirements 1.3, 1.4, 1.5, 1.8**
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: vi.fn(async (fn: Function) => fn()),
      validateIdentifier: vi.fn((id: string) => id),
    },
  };
});

vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ArchiveService } from '../ArchiveService';
import { db } from '../../db/index';
import { NotFoundError } from '../../utils/errors';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Arbitrary for valid plan IDs (UUID-like strings) */
const planIdArb = fc.uuid();

/** Arbitrary for valid user IDs (UUID-like strings) */
const userIdArb = fc.uuid();

/** Arbitrary for roles that are allowed to archive (Manager or Admin) */
const allowedRoleArb = fc.constantFrom('Manager', 'Admin');

/** Arbitrary for valid fiscal years */
const yearArb = fc.integer({ min: 2000, max: 2100 });

/** Arbitrary for a number of tasks (0 to 10 for testing) */
const taskCountArb = fc.integer({ min: 0, max: 10 });

/** Arbitrary for a number of findings (0 to 10 for testing) */
const findingCountArb = fc.integer({ min: 0, max: 10 });

/** Arbitrary for a number of recommendations (0 to 10 for testing) */
const recCountArb = fc.integer({ min: 0, max: 10 });

/** Arbitrary for a number of evidence items (0 to 10 for testing) */
const evidenceCountArb = fc.integer({ min: 0, max: 10 });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 1: Archived plans are immutable', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReset();
  });

  /**
   * **Validates: Requirements 1.3, 1.8**
   *
   * For any plan that is already archived (is_archived = true), attempting to
   * archive it again must be rejected with a NotFoundError. Once a plan is
   * archived, it cannot be re-archived or modified through the archive workflow.
   *
   * This property ensures immutability: archived plans cannot be changed.
   */
  it('archivePlan throws NotFoundError for any already-archived plan regardless of planId, userId, or role', async () => {
    await fc.assert(
      fc.asyncProperty(
        planIdArb,
        userIdArb,
        allowedRoleArb,
        async (planId, userId, role) => {
          mockDb.prepare.mockReset();

          // Setup: First query (plan with is_archived = false) returns null
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue(null),
          });

          // Setup: Second query (plan exists but is_archived = true)
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: planId, is_archived: true }),
          });

          // Must throw NotFoundError indicating plan is already archived
          try {
            await ArchiveService.archivePlan(planId, userId, role);
            // Should never reach here
            expect.fail('Should have thrown NotFoundError');
          } catch (error: any) {
            expect(error).toBeInstanceOf(NotFoundError);
            expect(error.message).toContain('مؤرشفة مسبقاً');
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.8**
   *
   * For any already-archived plan, the archive operation must not execute any
   * INSERT or DELETE operations on the database. The rejection must happen
   * before any data modification.
   */
  it('archivePlan does not perform any INSERT or DELETE when plan is already archived', async () => {
    await fc.assert(
      fc.asyncProperty(
        planIdArb,
        userIdArb,
        allowedRoleArb,
        async (planId, userId, role) => {
          mockDb.prepare.mockReset();

          // Track call count to return different values for each db.prepare() call
          let callCount = 0;
          mockDb.prepare.mockImplementation((_sql: string) => {
            callCount++;
            if (callCount === 1) {
              // First query: plan with is_archived = false → not found
              return { get: vi.fn().mockResolvedValue(null) };
            }
            if (callCount === 2) {
              // Second query: plan exists but is_archived = true
              return { get: vi.fn().mockResolvedValue({ id: planId, is_archived: true }) };
            }
            // Should never reach here - but return safe defaults
            return { get: vi.fn().mockResolvedValue(null), run: vi.fn().mockResolvedValue(undefined), all: vi.fn().mockResolvedValue([]) };
          });

          try {
            await ArchiveService.archivePlan(planId, userId, role);
            expect.fail('Should have thrown NotFoundError');
          } catch {
            // Expected to throw
          }

          // Verify only SELECT queries were issued (no INSERT, DELETE, or UPDATE)
          const calls = mockDb.prepare.mock.calls;
          for (const call of calls) {
            const sql = call[0] as string;
            expect(sql).toMatch(/^SELECT/i);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('Property 15: Archive separation (data moved to archive tables)', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReset();
  });

  /**
   * **Validates: Requirements 1.3, 1.4, 1.5**
   *
   * For any successful archive operation with N tasks, M findings, P recommendations,
   * and Q evidence items, the archive process must:
   * 1. INSERT data into archive tables (archived_plans, archived_tasks, etc.) as JSONB
   * 2. DELETE data from regular tables AFTER the inserts
   *
   * This property verifies that the archive workflow always performs INSERTs into
   * archive tables before DELETEs from regular tables, ensuring data is never lost.
   */
  it('archive process always INSERTs into archive tables before DELETEs from regular tables', async () => {
    await fc.assert(
      fc.asyncProperty(
        planIdArb,
        userIdArb,
        allowedRoleArb,
        yearArb,
        taskCountArb,
        findingCountArb,
        recCountArb,
        evidenceCountArb,
        async (planId, userId, role, year, taskCount, findingCount, recCount, evidenceCount) => {
          mockDb.prepare.mockReset();

          const samplePlan = {
            id: planId,
            plan_code: `IA-PL-${String(year).slice(-2)}-001`,
            title: `Plan ${year}`,
            year,
            status: 'Closed',
            is_archived: false,
          };

          // Generate sample data arrays
          const tasks = Array.from({ length: taskCount }, (_, i) => ({
            id: `task-${i}`,
            plan_id: planId,
            status: 'completed',
          }));
          const findings = Array.from({ length: findingCount }, (_, i) => ({
            id: `finding-${i}`,
            audit_id: planId,
            status: 'Closed',
          }));
          const recs = Array.from({ length: recCount }, (_, i) => ({
            id: `rec-${i}`,
            finding_id: `finding-0`,
            status: 'Implemented',
          }));
          const evidence = Array.from({ length: evidenceCount }, (_, i) => ({
            id: `ev-${i}`,
            audit_id: planId,
            finding_id: `finding-0`,
          }));

          // Track all SQL statements in order
          const executedSql: string[] = [];

          // Track how many items have been fetched for each type
          let tasksFetched = false;
          let findingsFetched = false;
          let recsFetched = false;
          let evidenceFetched = false;

          mockDb.prepare.mockImplementation((sql: string) => {
            executedSql.push(sql);

            if (sql.includes('is_archived = false')) {
              return { get: vi.fn().mockResolvedValue(samplePlan) };
            }
            if (sql.includes('audit_tasks') && sql.includes('COUNT') && !sql.includes('archived_')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            if (sql.includes('audit_findings') && sql.includes('COUNT') && sql.includes('status') && !sql.includes('archived_')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            if (sql.includes('recommendations') && sql.includes('COUNT') && sql.includes('NOT IN')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            if (sql.includes('INSERT INTO archived_')) {
              return { run: vi.fn().mockResolvedValue({ lastInsertRowid: 'a-1', changes: 1 }) };
            }
            // Fetch tasks
            if (sql.includes('SELECT') && sql.includes('FROM audit_tasks') && sql.includes('plan_id') && !tasksFetched) {
              tasksFetched = true;
              return { all: vi.fn().mockResolvedValue(tasks) };
            }
            // Fetch findings
            if (sql.includes('SELECT') && sql.includes('FROM audit_findings') && sql.includes('audit_id') && !findingsFetched) {
              findingsFetched = true;
              return { all: vi.fn().mockResolvedValue(findings) };
            }
            // Fetch recommendations (JOIN query)
            if (sql.includes('SELECT') && sql.includes('FROM recommendations') && sql.includes('JOIN') && !recsFetched) {
              recsFetched = true;
              return { all: vi.fn().mockResolvedValue(recs) };
            }
            // Fetch evidence
            if (sql.includes('SELECT') && sql.includes('FROM audit_evidence') && !evidenceFetched) {
              evidenceFetched = true;
              return { all: vi.fn().mockResolvedValue(evidence) };
            }
            // Verify archived counts
            if (sql.includes('COUNT') && sql.includes('archived_tasks')) {
              return { get: vi.fn().mockResolvedValue({ count: taskCount }) };
            }
            if (sql.includes('COUNT') && sql.includes('archived_findings')) {
              return { get: vi.fn().mockResolvedValue({ count: findingCount }) };
            }
            if (sql.includes('COUNT') && sql.includes('archived_recommendations')) {
              return { get: vi.fn().mockResolvedValue({ count: recCount }) };
            }
            if (sql.includes('COUNT') && sql.includes('archived_evidence')) {
              return { get: vi.fn().mockResolvedValue({ count: evidenceCount }) };
            }
            if (sql.includes('DELETE')) {
              return { run: vi.fn().mockResolvedValue({ changes: 0 }) };
            }
            if (sql.includes('UPDATE audit_plans')) {
              return { run: vi.fn().mockResolvedValue({ changes: 1 }) };
            }
            if (sql.includes('SELECT year')) {
              return { get: vi.fn().mockResolvedValue({ year }) };
            }
            return { get: vi.fn().mockResolvedValue({ count: 0 }), run: vi.fn().mockResolvedValue({ changes: 0 }), all: vi.fn().mockResolvedValue([]) };
          });

          await ArchiveService.archivePlan(planId, userId, role);

          // Verify: All INSERTs into archive tables happen BEFORE any DELETE
          const firstArchiveInsertIdx = executedSql.findIndex((sql: string) =>
            sql?.includes('INSERT INTO archived_')
          );
          const firstDeleteIdx = executedSql.findIndex((sql: string) =>
            sql?.match(/DELETE FROM (audit_evidence|recommendations|audit_findings|audit_tasks)/)
          );

          // If there are items to archive, INSERTs must come before DELETEs
          if (firstArchiveInsertIdx !== -1 && firstDeleteIdx !== -1) {
            expect(firstArchiveInsertIdx).toBeLessThan(firstDeleteIdx);
          }

          // Verify: All archive INSERT calls exist for each data type
          const archiveInserts = executedSql.filter((sql: string) =>
            sql?.includes('INSERT INTO archived_')
          );

          // Plan is always archived (1 INSERT for archived_plans)
          // Plus one INSERT per task, finding, recommendation, and evidence
          const expectedInsertCount = 1 + taskCount + findingCount + recCount + evidenceCount;
          expect(archiveInserts.length).toBe(expectedInsertCount);

          // Verify: DELETE operations exist for regular tables
          const deleteOps = executedSql.filter((sql: string) =>
            sql?.match(/DELETE FROM (audit_evidence|recommendations|audit_findings|audit_tasks)/)
          );
          expect(deleteOps.length).toBe(4); // evidence, recommendations, findings, tasks
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 1.4**
   *
   * For any successful archive, the plan data is stored as JSONB in the archive table.
   * The INSERT into archived_plans must include the full plan data serialized as JSON.
   */
  it('archive process stores plan data as JSONB in archived_plans', async () => {
    await fc.assert(
      fc.asyncProperty(
        planIdArb,
        userIdArb,
        allowedRoleArb,
        yearArb,
        async (planId, userId, role, year) => {
          mockDb.prepare.mockReset();

          const samplePlan = {
            id: planId,
            plan_code: `IA-PL-${String(year).slice(-2)}-001`,
            title: `Plan ${year}`,
            year,
            status: 'Closed',
            is_archived: false,
          };

          // Track the arguments passed to the archived_plans INSERT
          let archivePlanArgs: any[] = [];

          // Use mockImplementation to handle all db.prepare calls dynamically
          let callIndex = 0;
          mockDb.prepare.mockImplementation((sql: string) => {
            callIndex++;

            // Plan found (not archived)
            if (sql.includes('is_archived = false')) {
              return { get: vi.fn().mockResolvedValue(samplePlan) };
            }
            // Open tasks count
            if (sql.includes('audit_tasks') && sql.includes('COUNT') && !sql.includes('archived_')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            // Open findings count
            if (sql.includes('audit_findings') && sql.includes('COUNT') && sql.includes('status') && !sql.includes('archived_')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            // Open recommendations count
            if (sql.includes('recommendations') && sql.includes('COUNT') && sql.includes('NOT IN')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            // Archive plan INSERT - capture args
            if (sql.includes('INSERT INTO archived_plans')) {
              return {
                run: vi.fn((...args: any[]) => {
                  archivePlanArgs = args;
                  return Promise.resolve({ lastInsertRowid: 'ap-1', changes: 1 });
                }),
              };
            }
            // Other INSERT operations
            if (sql.includes('INSERT INTO archived_')) {
              return { run: vi.fn().mockResolvedValue({ lastInsertRowid: 'a-1', changes: 1 }) };
            }
            // DELETE operations (must come before SELECT check due to subqueries containing SELECT)
            if (sql.includes('DELETE')) {
              return { run: vi.fn().mockResolvedValue({ changes: 0 }) };
            }
            // Fetch tasks/findings/recs/evidence (all empty)
            if (sql.trimStart().startsWith('SELECT') && (sql.includes('FROM audit_tasks') || sql.includes('FROM audit_findings') || sql.includes('FROM recommendations') || sql.includes('FROM audit_evidence'))) {
              return { all: vi.fn().mockResolvedValue([]) };
            }
            // Verify archived counts
            if (sql.includes('COUNT') && sql.includes('archived_')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            // UPDATE plan
            if (sql.includes('UPDATE audit_plans')) {
              return { run: vi.fn().mockResolvedValue({ changes: 1 }) };
            }
            // Fetch plan year for N8n event
            if (sql.includes('SELECT year')) {
              return { get: vi.fn().mockResolvedValue({ year }) };
            }
            // Fallback
            return { get: vi.fn().mockResolvedValue({ count: 0 }), run: vi.fn().mockResolvedValue({ changes: 0 }), all: vi.fn().mockResolvedValue([]) };
          });

          await ArchiveService.archivePlan(planId, userId, role);

          // Verify the archived_plans INSERT was called with JSON-serialized plan data
          expect(archivePlanArgs[0]).toBe(planId);
          expect(archivePlanArgs[1]).toBe(JSON.stringify(samplePlan));
          expect(archivePlanArgs[2]).toBe(year);
          expect(archivePlanArgs[3]).toBe(userId);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 1.5**
   *
   * After a successful archive, the plan row remains in audit_plans with
   * is_archived = true and status = 'Archived'. The UPDATE must always be
   * the last modification to the plan row.
   */
  it('archive process marks plan as is_archived=true after moving data to archive tables', async () => {
    await fc.assert(
      fc.asyncProperty(
        planIdArb,
        userIdArb,
        allowedRoleArb,
        yearArb,
        async (planId, userId, role, year) => {
          mockDb.prepare.mockReset();

          const samplePlan = {
            id: planId,
            plan_code: `IA-PL-${String(year).slice(-2)}-001`,
            title: `Plan ${year}`,
            year,
            status: 'Closed',
            is_archived: false,
          };

          // Track all SQL statements in order
          const executedSql: string[] = [];

          mockDb.prepare.mockImplementation((sql: string) => {
            executedSql.push(sql);

            if (sql.includes('is_archived = false')) {
              return { get: vi.fn().mockResolvedValue(samplePlan) };
            }
            if (sql.includes('audit_tasks') && sql.includes('COUNT') && !sql.includes('archived_')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            if (sql.includes('audit_findings') && sql.includes('COUNT') && sql.includes('status') && !sql.includes('archived_')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            if (sql.includes('recommendations') && sql.includes('COUNT') && sql.includes('NOT IN')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            if (sql.includes('INSERT INTO archived_')) {
              return { run: vi.fn().mockResolvedValue({ lastInsertRowid: 'a-1', changes: 1 }) };
            }
            if (sql.includes('DELETE')) {
              return { run: vi.fn().mockResolvedValue({ changes: 0 }) };
            }
            if (sql.trimStart().startsWith('SELECT') && (sql.includes('FROM audit_tasks') || sql.includes('FROM audit_findings') || sql.includes('FROM recommendations') || sql.includes('FROM audit_evidence'))) {
              return { all: vi.fn().mockResolvedValue([]) };
            }
            if (sql.includes('COUNT') && sql.includes('archived_')) {
              return { get: vi.fn().mockResolvedValue({ count: 0 }) };
            }
            if (sql.includes('UPDATE audit_plans')) {
              return { run: vi.fn().mockResolvedValue({ changes: 1 }) };
            }
            if (sql.includes('SELECT year')) {
              return { get: vi.fn().mockResolvedValue({ year }) };
            }
            return { get: vi.fn().mockResolvedValue({ count: 0 }), run: vi.fn().mockResolvedValue({ changes: 0 }), all: vi.fn().mockResolvedValue([]) };
          });

          await ArchiveService.archivePlan(planId, userId, role);

          // Verify the UPDATE to mark plan as archived exists and comes after DELETEs
          const updatePlanIdx = executedSql.findIndex((sql: string) =>
            sql?.includes('UPDATE audit_plans SET is_archived = true')
          );
          const lastDeleteIdx = Math.max(
            ...executedSql.map((sql: string, idx: number) =>
              sql?.match(/DELETE FROM (audit_evidence|recommendations|audit_findings|audit_tasks)/)
                ? idx
                : -1
            )
          );

          // UPDATE must exist
          expect(updatePlanIdx).toBeGreaterThan(-1);

          // UPDATE must come after all DELETEs
          if (lastDeleteIdx > -1) {
            expect(updatePlanIdx).toBeGreaterThan(lastDeleteIdx);
          }

          // The UPDATE SQL must set is_archived = true and status = 'Archived'
          const updateSql = executedSql[updatePlanIdx];
          expect(updateSql).toContain('is_archived = true');
          expect(updateSql).toContain("status = 'Archived'");
        }
      ),
      { numRuns: 200 }
    );
  });
});
