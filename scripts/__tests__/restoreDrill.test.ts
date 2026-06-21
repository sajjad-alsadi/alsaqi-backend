// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  CRITICAL_TABLES,
  buildTableRowCounts,
  allRowCountsMatch,
  buildRestoreDrillLog,
  type TableRowCountPair,
} from '../restoreDrill';

/**
 * Restore_Drill pure-logic tests (Req 3.8).
 *
 * Validity rule under test (design.md region (ي)):
 *   verifiedRestorable === true  ⇔  result === 'verified'
 *                                ⇔  restore succeeded AND every critical table's
 *                                    expected === actual row count.
 *   Any restore failure OR any count mismatch ⇒ result === 'failed' and
 *   verifiedRestorable === false.
 */

const baseInput = {
  restoreId: 'restore-1',
  backupId: 'backup-1',
  executedAt: '2026-01-01T00:00:00.000Z',
  targetDatabase: 'restore_drill_target',
};

describe('buildTableRowCounts', () => {
  it('defaults missing expected/actual counts to 0 for every critical table', () => {
    const counts = buildTableRowCounts(CRITICAL_TABLES, {}, {});
    for (const table of CRITICAL_TABLES) {
      expect(counts[table]).toEqual({ expected: 0, actual: 0 });
    }
  });

  it('pairs expected and actual counts per table', () => {
    const counts = buildTableRowCounts(
      ['users', 'audit_tasks'],
      { users: 10, audit_tasks: 5 },
      { users: 10, audit_tasks: 4 }
    );
    expect(counts.users).toEqual({ expected: 10, actual: 10 });
    expect(counts.audit_tasks).toEqual({ expected: 5, actual: 4 });
  });
});

describe('allRowCountsMatch', () => {
  it('returns true when every table matches', () => {
    const counts: Record<string, TableRowCountPair> = {
      users: { expected: 3, actual: 3 },
      audit_tasks: { expected: 7, actual: 7 },
    };
    expect(allRowCountsMatch(counts)).toBe(true);
  });

  it('returns false when any table mismatches', () => {
    const counts: Record<string, TableRowCountPair> = {
      users: { expected: 3, actual: 3 },
      audit_tasks: { expected: 7, actual: 6 },
    };
    expect(allRowCountsMatch(counts)).toBe(false);
  });

  it('treats an empty map as a (vacuously) matching set', () => {
    expect(allRowCountsMatch({})).toBe(true);
  });
});

describe('buildRestoreDrillLog (Req 3.8)', () => {
  it("returns 'verified' with verifiedRestorable=true when restore succeeded and all counts match", () => {
    const tableRowCounts = buildTableRowCounts(
      CRITICAL_TABLES,
      Object.fromEntries(CRITICAL_TABLES.map((t) => [t, 5])),
      Object.fromEntries(CRITICAL_TABLES.map((t) => [t, 5]))
    );

    const log = buildRestoreDrillLog({
      ...baseInput,
      tableRowCounts,
      restoreSucceeded: true,
    });

    expect(log.result).toBe('verified');
    expect(log.verifiedRestorable).toBe(true);
  });

  it("returns 'failed' with verifiedRestorable=false when any critical table count mismatches", () => {
    const expected = Object.fromEntries(CRITICAL_TABLES.map((t) => [t, 5]));
    const actual = { ...expected, audit_findings: 4 }; // single mismatch
    const tableRowCounts = buildTableRowCounts(CRITICAL_TABLES, expected, actual);

    const log = buildRestoreDrillLog({
      ...baseInput,
      tableRowCounts,
      restoreSucceeded: true,
    });

    expect(log.result).toBe('failed');
    expect(log.verifiedRestorable).toBe(false);
  });

  it("returns 'failed' with verifiedRestorable=false when restore did not succeed, even if counts match", () => {
    const tableRowCounts = buildTableRowCounts(
      CRITICAL_TABLES,
      Object.fromEntries(CRITICAL_TABLES.map((t) => [t, 5])),
      Object.fromEntries(CRITICAL_TABLES.map((t) => [t, 5]))
    );

    const log = buildRestoreDrillLog({
      ...baseInput,
      tableRowCounts,
      restoreSucceeded: false,
    });

    expect(log.result).toBe('failed');
    expect(log.verifiedRestorable).toBe(false);
  });

  it('preserves identity fields and the tableRowCounts map in the log', () => {
    const tableRowCounts = buildTableRowCounts(['users'], { users: 1 }, { users: 1 });
    const log = buildRestoreDrillLog({
      ...baseInput,
      tableRowCounts,
      restoreSucceeded: true,
    });

    expect(log.restoreId).toBe(baseInput.restoreId);
    expect(log.backupId).toBe(baseInput.backupId);
    expect(log.executedAt).toBe(baseInput.executedAt);
    expect(log.targetDatabase).toBe(baseInput.targetDatabase);
    expect(log.tableRowCounts).toEqual(tableRowCounts);
  });

  // Property: verifiedRestorable holds iff restore succeeded AND all counts match,
  // and is always equivalent to (result === 'verified'). (Req 3.8)
  it('verifiedRestorable ⇔ restoreSucceeded && allRowCountsMatch (property)', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(
          fc.record({
            expected: fc.nat({ max: 1000 }),
            actual: fc.nat({ max: 1000 }),
          }),
          { maxLength: CRITICAL_TABLES.length }
        ),
        (restoreSucceeded, pairs) => {
          const tableRowCounts: Record<string, TableRowCountPair> = {};
          pairs.forEach((p, i) => {
            tableRowCounts[CRITICAL_TABLES[i]] = p;
          });

          const log = buildRestoreDrillLog({
            ...baseInput,
            tableRowCounts,
            restoreSucceeded,
          });

          const countsMatch = allRowCountsMatch(tableRowCounts);
          const shouldVerify = restoreSucceeded && countsMatch;

          expect(log.verifiedRestorable).toBe(shouldVerify);
          expect(log.result).toBe(shouldVerify ? 'verified' : 'failed');
          // The two indicators must always agree.
          expect(log.verifiedRestorable).toBe(log.result === 'verified');
        }
      )
    );
  });
});
