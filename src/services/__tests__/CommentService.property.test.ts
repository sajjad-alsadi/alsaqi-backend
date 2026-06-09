// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for CommentService (Property 10)
 *
 * Feature: audit-modules-restructure
 *
 * Property 10: Comment notification targeting
 *
 * **Validates: Requirements 9.2, 9.3, 9.4**
 *
 * Comment notifications on findings are targeted exclusively to the finding creator
 * or the last different commenter, depending on who is commenting:
 *
 * 1. For any commenter who is NOT the finding creator, exactly one notification
 *    is sent to the finding creator.
 * 2. For any commenter who IS the finding creator AND a previous different commenter
 *    exists, exactly one notification is sent to that last different commenter.
 * 3. For any commenter who IS the finding creator AND no previous different commenter
 *    exists, zero notifications are sent.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
    },
  };
});

vi.mock('../NotificationService', () => ({
  NotificationService: {
    create: vi.fn().mockResolvedValue(true),
  },
}));

import { CommentService } from '../CommentService';
import { db } from '../../db/index';
import { NotificationService } from '../NotificationService';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generate a UUID-like string */
const uuidArb = fc.uuid();

/** Generate valid comment content (1-2000 chars, non-whitespace-only) */
const validContentArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0 && s.trim().length <= 2000);

/**
 * Generate a scenario where commenter ≠ finding creator.
 * Ensures the two UUIDs are always different.
 */
const commenterNotCreatorArb = fc
  .tuple(uuidArb, uuidArb, uuidArb)
  .filter(([findingId, commenterId, creatorId]) => commenterId !== creatorId);

/**
 * Generate a scenario where commenter = finding creator AND a previous
 * different commenter exists.
 */
const creatorRepliesWithPreviousCommenterArb = fc
  .tuple(uuidArb, uuidArb, uuidArb)
  .filter(
    ([_findingId, creatorId, previousCommenterId]) =>
      creatorId !== previousCommenterId
  );

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 10: Comment notification targeting', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 9.2**
   *
   * For any commenter who is NOT the finding creator, exactly one notification
   * is sent to the finding creator.
   */
  it('commenter ≠ finding creator → exactly one notification sent to finding creator', async () => {
    await fc.assert(
      fc.asyncProperty(
        commenterNotCreatorArb,
        validContentArb,
        async ([findingId, commenterId, creatorId], content) => {
          vi.clearAllMocks();

          // Use sequential mockReturnValueOnce to match the exact call order in CommentService:
          // 1st prepare: SELECT from audit_findings (finding lookup)
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: findingId, created_by: creatorId }),
          });
          // 2nd prepare: INSERT INTO comments
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: 'comment-id-generated' }),
          });

          await CommentService.createFindingComment(findingId, content, commenterId);

          // Exactly one notification must be sent
          expect(NotificationService.create).toHaveBeenCalledTimes(1);

          // The notification recipient must be the finding creator
          const firstArg = (NotificationService.create as any).mock.calls[0][0];
          expect(firstArg).toBe(creatorId);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 9.3**
   *
   * For any commenter who IS the finding creator AND a previous different commenter
   * exists, exactly one notification is sent to that last different commenter.
   */
  it('commenter = finding creator AND previous different commenter exists → exactly one notification sent to last different commenter', async () => {
    await fc.assert(
      fc.asyncProperty(
        creatorRepliesWithPreviousCommenterArb,
        validContentArb,
        async ([findingId, creatorId, previousCommenterId], content) => {
          vi.clearAllMocks();

          // Use sequential mockReturnValueOnce to match the exact call order in CommentService:
          // 1st prepare: SELECT from audit_findings (finding lookup)
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: findingId, created_by: creatorId }),
          });
          // 2nd prepare: INSERT INTO comments
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: 'comment-id-generated' }),
          });
          // 3rd prepare: SELECT user_id FROM comments ... user_id != ? (last different commenter)
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ user_id: previousCommenterId }),
          });

          await CommentService.createFindingComment(findingId, content, creatorId);

          // Exactly one notification must be sent
          expect(NotificationService.create).toHaveBeenCalledTimes(1);

          // The notification recipient must be the previous different commenter
          const firstArg = (NotificationService.create as any).mock.calls[0][0];
          expect(firstArg).toBe(previousCommenterId);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 9.4**
   *
   * For any commenter who IS the finding creator AND no previous different commenter
   * exists, zero notifications are sent.
   */
  it('commenter = finding creator AND no previous different commenter → zero notifications sent', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        uuidArb,
        validContentArb,
        async (findingId, creatorId, content) => {
          vi.clearAllMocks();

          // Use sequential mockReturnValueOnce to match the exact call order in CommentService:
          // 1st prepare: SELECT from audit_findings (finding lookup)
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: findingId, created_by: creatorId }),
          });
          // 2nd prepare: INSERT INTO comments
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: 'comment-id-generated' }),
          });
          // 3rd prepare: SELECT user_id FROM comments ... user_id != ? (no previous different commenter)
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue(undefined),
          });

          await CommentService.createFindingComment(findingId, content, creatorId);

          // Zero notifications must be sent
          expect(NotificationService.create).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });
});
