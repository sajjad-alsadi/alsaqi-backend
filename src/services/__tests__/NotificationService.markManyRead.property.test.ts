// @vitest-environment node
// Feature: backend-api-contract-alignment, Property 11: bulk mark-read updates only current user's unread listed notifications and returns exact count
//
// **Property 11: صحّة وعزل التعليم الجماعي للإشعارات**
// **Validates: Requirements 9.2, 9.3, 9.4**
//
// For any set of notifications belonging to multiple users with random read
// states, and any `notification_ids` list a current user submits (including
// duplicates, non-existent ids, and other users' ids), invoking the bulk
// mark-read:
//   (1) never changes the read state of any notification not owned by the
//       current user (isolation — R9.2/R9.3), and
//   (2) returns `updated` exactly equal to the count of the current user's
//       notifications that were previously unread AND whose ids were listed
//       (i.e. the ones that genuinely transitioned to read — R9.4).
//
// The test backs the mocked `db.prepare(...).run(...)` with a model-based
// in-memory store, mirroring how the existing NotificationService.test.ts
// mocks the db module. The mock replicates the real UPDATE semantics:
//   recipient_id = userId AND is_read = false AND notification_id = ANY(ids).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';

// In-memory store + db mock created via vi.hoisted so the vi.mock factory can
// reference them. The store is mutated in place by the mocked `run`, exactly as
// a real UPDATE would mutate the notification_recipients rows.
const { storeHolder, mockPrepare } = vi.hoisted(() => {
  const storeHolder = {
    records: [] as Array<{ notification_id: string; recipient_id: string; is_read: boolean }>,
  };

  const mockPrepare = vi.fn((sql: string) => ({
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn((...args: unknown[]) => {
      // Primary markManyRead path:
      // UPDATE notification_recipients SET is_read = true ...
      //   WHERE recipient_id = ?::uuid AND is_read = false
      //     AND notification_id = ANY(?::uuid[])
      if (
        sql.includes('notification_recipients') &&
        sql.includes('is_read = false') &&
        sql.includes('ANY')
      ) {
        const userId = String(args[0]);
        const ids = (args[1] as Array<string | number>) ?? [];
        const idSet = new Set(ids.map((x) => String(x)));
        let changes = 0;
        for (const r of storeHolder.records) {
          if (r.recipient_id === userId && r.is_read === false && idSet.has(r.notification_id)) {
            r.is_read = true;
            changes++;
          }
        }
        return { changes };
      }
      return { changes: 0 };
    }),
  }));

  return { storeHolder, mockPrepare };
});

vi.mock('../../db/index', () => ({
  db: {
    prepare: mockPrepare,
    transaction: vi.fn((fn: Function) => fn()),
  },
}));

import { NotificationService } from '../NotificationService';

interface Scenario {
  users: string[];
  records: Array<{ notification_id: string; recipient_id: string; is_read: boolean }>;
  currentUser: string;
  notificationIds: Array<string>;
}

// Generates a multi-user notification set with random read states plus a
// notification_ids list that intentionally mixes: the current user's read and
// unread ids, other users' ids, duplicates, and fabricated non-existent ids.
const scenarioArb: fc.Arbitrary<Scenario> = fc
  .integer({ min: 2, max: 5 })
  .chain((numUsers) => {
    const users = Array.from({ length: numUsers }, (_, i) => `user-${i}`);
    return fc
      .record({
        notifs: fc.array(
          fc.record({
            owner: fc.integer({ min: 0, max: numUsers - 1 }),
            isRead: fc.boolean(),
          }),
          { minLength: 0, maxLength: 30 }
        ),
        currentUserIndex: fc.integer({ min: 0, max: numUsers - 1 }),
      })
      .chain(({ notifs, currentUserIndex }) => {
        const records = notifs.map((n, i) => ({
          notification_id: `n-${i}`,
          recipient_id: users[n.owner],
          is_read: n.isRead,
        }));
        const existingIds = records.map((r) => r.notification_id);
        // Each requested id is either an existing one (any user's) or a
        // fabricated non-existent id; the array allows duplicates.
        const idEntryArb =
          existingIds.length > 0
            ? fc.oneof(
                { weight: 3, arbitrary: fc.constantFrom(...existingIds) },
                { weight: 1, arbitrary: fc.string({ maxLength: 6 }).map((s) => `missing-${s}`) }
              )
            : fc.string({ maxLength: 6 }).map((s) => `missing-${s}`);
        return fc
          .array(idEntryArb, { minLength: 0, maxLength: 40 })
          .map((notificationIds) => ({
            users,
            records,
            currentUser: users[currentUserIndex],
            notificationIds,
          }));
      });
  });

describe('Feature: backend-api-contract-alignment, Property 11: bulk mark-read updates only current user\'s unread listed notifications and returns exact count', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeHolder.records = [];
  });

  it('marks only the current user\'s previously-unread listed notifications, leaves other users untouched, and returns the exact transitioned count', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ records, currentUser, notificationIds }) => {
        // Snapshot the pre-call state for isolation / correctness comparison.
        const before = records.map((r) => ({ ...r }));
        const idSet = new Set(notificationIds.map((x) => String(x)));

        // Model expectation: count of the current user's records that were
        // unread AND whose id appears in the (deduped) requested list.
        const expectedUpdated = before.filter(
          (r) => r.recipient_id === currentUser && r.is_read === false && idSet.has(r.notification_id)
        ).length;

        // Load the store the mocked db will mutate.
        storeHolder.records = records;

        const updated = await NotificationService.markManyRead(notificationIds, currentUser);

        // (R9.4) returned count equals the exact number of genuine transitions.
        expect(updated).toBe(expectedUpdated);

        // Compare resulting state record-by-record.
        for (let i = 0; i < before.length; i++) {
          const prev = before[i];
          const now = records[i];
          if (prev.recipient_id !== currentUser) {
            // (R9.2/R9.3) other users' notifications are never modified, even
            // if their ids were included in the request.
            expect(now.is_read).toBe(prev.is_read);
          } else if (prev.is_read === false && idSet.has(prev.notification_id)) {
            // Current user's previously-unread listed notifications become read.
            expect(now.is_read).toBe(true);
          } else {
            // Current user's already-read or unlisted notifications are unchanged.
            expect(now.is_read).toBe(prev.is_read);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
