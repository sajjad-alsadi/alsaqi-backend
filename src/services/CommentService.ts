import { db } from '../db/index';
import { NotificationService } from './NotificationService';
import { ValidationError, NotFoundError } from '../utils/errors';

export class CommentService {
  static async getComments(type: string, id: string | number) {
    return await db.prepare(`
      SELECT c.*, u.name as user_name 
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.related_type = ? AND c.related_id = ?
      ORDER BY c.created_at ASC
    `).all(type, id);
  }

  static async createComment(userId: string | number, data: any) {
    const { related_type, related_id, content } = data;
    const stmt = db.prepare(`
      INSERT INTO comments (related_type, related_id, user_id, content)
      VALUES (?, ?, ?, ?)
    `);
    const result = await stmt.run(related_type, related_id, userId, content);
    return { id: result.lastInsertRowid };
  }

  /**
   * Create a comment on an audit finding with targeted notification logic.
   * 
   * Notification rules:
   * 1. If commenter ≠ finding creator → notify finding creator
   * 2. If commenter = finding creator AND previous different commenter exists → notify last different commenter
   * 3. If commenter = finding creator AND no previous different commenter → no notification
   * 
   * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
   */
  static async createFindingComment(
    findingId: string,
    content: string,
    userId: string
  ): Promise<{ commentId: string }> {
    // Validate content: non-empty after trim, max 2000 chars (Requirement 9.1, 9.5)
    const trimmedContent = content?.trim() ?? '';
    if (trimmedContent.length === 0 || trimmedContent.length > 2000) {
      throw new ValidationError(
        'Comment content must be non-empty and at most 2000 characters after trimming'
      );
    }

    // Validate finding exists (Requirement 9.6)
    const finding = await db.prepare(
      "SELECT id, created_by FROM audit_findings WHERE id = ?"
    ).get(findingId) as { id: string; created_by: string } | undefined;

    if (!finding) {
      throw new NotFoundError('Finding not found');
    }

    // Create the comment record (Requirement 9.1)
    const result = await db.prepare(`
      INSERT INTO comments (related_type, related_id, user_id, content)
      VALUES ('audit_findings', ?, ?, ?)
    `).get(findingId, userId, trimmedContent) as { id: string } | undefined;

    const commentId = result?.id || (await db.prepare(
      "SELECT id FROM comments WHERE related_type = 'audit_findings' AND related_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(findingId, userId) as any)?.id;

    // Notification logic (Requirements 9.2, 9.3, 9.4)
    if (userId !== finding.created_by) {
      // Case 1: Commenter ≠ finding creator → notify finding creator (Requirement 9.2)
      await NotificationService.create(
        finding.created_by,
        'comment_added',
        JSON.stringify({ key: 'notifications.commentOnYourFinding', params: { findingId } }),
        'AuditFindings',
        `/findings/${findingId}`,
        {
          actorId: userId,
          entityId: findingId,
          entityType: 'audit_findings',
        }
      );
    } else {
      // Commenter = finding creator (reply scenario)
      // Find the last different commenter (Requirement 9.3)
      const lastCommenter = await db.prepare(`
        SELECT user_id FROM comments 
        WHERE related_type = 'audit_findings' AND related_id = ? AND user_id != ?
        ORDER BY created_at DESC LIMIT 1
      `).get(findingId, userId) as { user_id: string } | undefined;

      if (lastCommenter) {
        // Case 2: Previous different commenter exists → notify them (Requirement 9.3)
        await NotificationService.create(
          lastCommenter.user_id,
          'comment_added',
          JSON.stringify({ key: 'notifications.replyToYourComment', params: { findingId } }),
          'AuditFindings',
          `/findings/${findingId}`,
          {
            actorId: userId,
            entityId: findingId,
            entityType: 'audit_findings',
          }
        );
      }
      // Case 3: No previous different commenter → no notification (Requirement 9.4)
    }

    return { commentId };
  }
}
