// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
    },
  };
});

// Mock NotificationService
vi.mock('../NotificationService', () => ({
  NotificationService: {
    create: vi.fn().mockResolvedValue(true),
  },
}));

import { CommentService } from '../CommentService';
import { db } from '../../db/index';
import { NotificationService } from '../NotificationService';
import { ValidationError, NotFoundError } from '../../utils/errors';

describe('CommentService', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createFindingComment', () => {
    const findingId = 'finding-uuid-001';
    const userId = 'user-uuid-001';
    const creatorId = 'creator-uuid-001';
    const validContent = 'This is a valid comment';

    describe('Content Validation (Requirements 9.1, 9.5)', () => {
      it('should reject empty content', async () => {
        await expect(
          CommentService.createFindingComment(findingId, '', userId)
        ).rejects.toThrow(ValidationError);
      });

      it('should reject whitespace-only content', async () => {
        await expect(
          CommentService.createFindingComment(findingId, '   \t\n  ', userId)
        ).rejects.toThrow(ValidationError);
      });

      it('should reject content exceeding 2000 characters after trim', async () => {
        const longContent = 'a'.repeat(2001);
        await expect(
          CommentService.createFindingComment(findingId, longContent, userId)
        ).rejects.toThrow(ValidationError);
      });

      it('should accept content exactly 2000 characters after trim', async () => {
        const exactContent = 'a'.repeat(2000);

        // Finding exists
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: creatorId }),
        });

        // Comment insert
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: 'comment-uuid-001' }),
        });

        const result = await CommentService.createFindingComment(findingId, exactContent, userId);
        expect(result.commentId).toBe('comment-uuid-001');
      });

      it('should trim leading/trailing whitespace before validation', async () => {
        const paddedContent = '  valid content  ';

        // Finding exists
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: creatorId }),
        });

        // Comment insert
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: 'comment-uuid-001' }),
        });

        const result = await CommentService.createFindingComment(findingId, paddedContent, userId);
        expect(result.commentId).toBe('comment-uuid-001');
      });

      it('should not create comment or send notification when content is invalid', async () => {
        await expect(
          CommentService.createFindingComment(findingId, '', userId)
        ).rejects.toThrow(ValidationError);

        // DB should not be called at all
        expect(mockDb.prepare).not.toHaveBeenCalled();
        expect(NotificationService.create).not.toHaveBeenCalled();
      });
    });

    describe('Finding Existence Validation (Requirement 9.6)', () => {
      it('should reject when finding does not exist', async () => {
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(undefined),
        });

        await expect(
          CommentService.createFindingComment(findingId, validContent, userId)
        ).rejects.toThrow(NotFoundError);
      });

      it('should not create comment or send notification when finding does not exist', async () => {
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(undefined),
        });

        await expect(
          CommentService.createFindingComment(findingId, validContent, userId)
        ).rejects.toThrow(NotFoundError);

        // Only 1 prepare call (finding lookup), no insert or notification
        expect(mockDb.prepare).toHaveBeenCalledTimes(1);
        expect(NotificationService.create).not.toHaveBeenCalled();
      });
    });

    describe('Notification: Commenter ≠ Finding Creator (Requirement 9.2)', () => {
      it('should notify finding creator when commenter is different', async () => {
        // Finding exists with different creator
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: creatorId }),
        });

        // Comment insert
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: 'comment-uuid-001' }),
        });

        await CommentService.createFindingComment(findingId, validContent, userId);

        expect(NotificationService.create).toHaveBeenCalledTimes(1);
        expect(NotificationService.create).toHaveBeenCalledWith(
          creatorId,
          'comment_added',
          expect.stringContaining('commentOnYourFinding'),
          'AuditFindings',
          `/findings/${findingId}`,
          expect.objectContaining({
            actorId: userId,
            entityId: findingId,
            entityType: 'audit_findings',
          })
        );
      });

      it('should send exactly one notification to the finding creator', async () => {
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: creatorId }),
        });

        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: 'comment-uuid-001' }),
        });

        await CommentService.createFindingComment(findingId, validContent, userId);

        expect(NotificationService.create).toHaveBeenCalledTimes(1);
        // First argument should be the creator ID (single recipient)
        expect((NotificationService.create as any).mock.calls[0][0]).toBe(creatorId);
      });
    });

    describe('Notification: Commenter = Finding Creator with previous commenter (Requirement 9.3)', () => {
      it('should notify last different commenter when creator replies', async () => {
        const previousCommenterId = 'previous-commenter-uuid';

        // Finding exists - creator is the commenter
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: userId }),
        });

        // Comment insert
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: 'comment-uuid-001' }),
        });

        // Last different commenter query
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ user_id: previousCommenterId }),
        });

        await CommentService.createFindingComment(findingId, validContent, userId);

        expect(NotificationService.create).toHaveBeenCalledTimes(1);
        expect(NotificationService.create).toHaveBeenCalledWith(
          previousCommenterId,
          'comment_added',
          expect.stringContaining('replyToYourComment'),
          'AuditFindings',
          `/findings/${findingId}`,
          expect.objectContaining({
            actorId: userId,
            entityId: findingId,
            entityType: 'audit_findings',
          })
        );
      });

      it('should notify the LAST different commenter (most recent)', async () => {
        const lastCommenterId = 'last-commenter-uuid';

        // Finding exists - creator is the commenter
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: userId }),
        });

        // Comment insert
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: 'comment-uuid-001' }),
        });

        // Last different commenter query returns the most recent one
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ user_id: lastCommenterId }),
        });

        await CommentService.createFindingComment(findingId, validContent, userId);

        expect((NotificationService.create as any).mock.calls[0][0]).toBe(lastCommenterId);
      });
    });

    describe('Notification: Commenter = Finding Creator with no previous commenter (Requirement 9.4)', () => {
      it('should not send any notification when creator comments and no previous different commenter exists', async () => {
        // Finding exists - creator is the commenter
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: userId }),
        });

        // Comment insert
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: 'comment-uuid-001' }),
        });

        // Last different commenter query returns nothing
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(undefined),
        });

        await CommentService.createFindingComment(findingId, validContent, userId);

        expect(NotificationService.create).not.toHaveBeenCalled();
      });

      it('should still create the comment even when no notification is sent', async () => {
        // Finding exists - creator is the commenter
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: userId }),
        });

        // Comment insert
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: 'comment-uuid-002' }),
        });

        // Last different commenter query returns nothing
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue(undefined),
        });

        const result = await CommentService.createFindingComment(findingId, validContent, userId);
        expect(result.commentId).toBe('comment-uuid-002');
      });
    });

    describe('Comment creation (Requirement 9.1)', () => {
      it('should create comment with entity_type audit_findings', async () => {
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: creatorId }),
        });

        const mockGet = vi.fn().mockResolvedValue({ id: 'comment-uuid-001' });
        mockDb.prepare.mockReturnValueOnce({ get: mockGet });

        await CommentService.createFindingComment(findingId, validContent, userId);

        // Verify the INSERT was called (second prepare call)
        const insertCall = mockDb.prepare.mock.calls[1][0];
        expect(insertCall).toContain('audit_findings');
        expect(insertCall).toContain('INSERT INTO comments');
      });

      it('should return the created comment ID', async () => {
        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: findingId, created_by: creatorId }),
        });

        mockDb.prepare.mockReturnValueOnce({
          get: vi.fn().mockResolvedValue({ id: 'new-comment-id' }),
        });

        const result = await CommentService.createFindingComment(findingId, validContent, userId);
        expect(result.commentId).toBe('new-comment-id');
      });
    });
  });
});
