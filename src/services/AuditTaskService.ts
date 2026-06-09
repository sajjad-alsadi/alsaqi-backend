import { db } from '../db/index';
import { NotFoundError, ValidationError, ForbiddenError, ConflictError } from '../utils/errors';
import { N8nService } from '../utils/n8nService';
import { UserRole } from '@alsaqi/shared';
import { parsePaginationParams, computePaginationMeta } from '../utils/paginationService';

const ALLOWED_TRANSITIONS: Record<string, Record<string, { roles: string[] }>> = {
  'draft': {
    'in_progress': { roles: ['Auditor', UserRole.INTERNAL_AUDITOR, UserRole.MANAGER] }
  },
  'in_progress': {
    'review': { roles: ['Auditor', UserRole.INTERNAL_AUDITOR] }
  },
  'review': {
    'approved': { roles: [UserRole.MANAGER] },
    'in_progress': { roles: [UserRole.MANAGER] }
  },
  'approved': {
    'completed': { roles: [UserRole.MANAGER] }
  }
};

export class AuditTaskService {
  static async changeStatus(taskId: string, newStatus: string, userId: string, userRole: string, _db: any) {
    const database = _db || db;
    const task = await database.prepare('SELECT id, title, task_number, status, plan_id FROM audit_tasks WHERE id = ?').get(taskId) as any;
    
    if (!task) throw new NotFoundError('IAMS-NOT-001');
    
    const allowed = ALLOWED_TRANSITIONS[task.status.toLowerCase()]?.[newStatus.toLowerCase()];
    if (!allowed) throw new ValidationError('Invalid status transition');
    
    if (!allowed.roles.includes(userRole)) {
      throw new ForbiddenError('IAMS-PERM-001');
    }

    // in_progress -> review: block on open critical/high findings
    if (newStatus === 'review') {
      const blocking = await database.prepare(`
        SELECT id FROM audit_findings 
        WHERE audit_id = ? AND status = 'open' 
        AND risk_level IN ('Critical', 'High')
      `).all(task.plan_id);
      
      if (blocking.length > 0)
        throw new ValidationError('Open critical/high findings block this transition');
    }

    // review -> approved: block if any recommendation lacks an action plan
    if (newStatus === 'approved') {
      const incomplete = await database.prepare(`
        SELECT r.id FROM recommendations r
        JOIN audit_findings f ON r.finding_id = f.id
        WHERE f.audit_id = ? 
        AND (r.action_plan IS NULL OR r.action_plan = '' OR r.due_date IS NULL)
      `).all(task.plan_id);
      
      if (incomplete.length > 0)
        throw new ValidationError('All recommendations must have an action plan and due date');
    }

    const result = await database.prepare(
      'UPDATE audit_tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(newStatus, taskId);

    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('audit_task.status_changed', {
      taskId: taskId,
      taskNumber: task.task_number,
      title: task.title,
      oldStatus: task.status,
      newStatus: newStatus,
      changedByUserId: userId
    }).catch(e => console.error("n8n send error", e));

    return result;
  }

  /**
   * Assigns multiple users to a task within a single transaction.
   *
   * Validates:
   * - assignedBy user has Manager or Admin role
   * - Task exists
   * - userIds is non-empty and has at most 50 entries
   * - All user IDs exist in the users table
   * - No duplicate assignments (UNIQUE constraint on task_id, user_id)
   *
   * @param taskId - The task to assign users to
   * @param userIds - Array of user IDs to assign (1-50)
   * @param assignedBy - The user performing the assignment
   * @returns Array of created assignment records
   */
  static async assignUsers(taskId: string, userIds: string[], assignedBy: string): Promise<{ assignments: any[] }> {
    // Validate userIds is non-empty and within limit
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      throw new ValidationError('قائمة المستخدمين فارغة. يجب تحديد مستخدم واحد على الأقل', { field: 'userIds' });
    }
    if (userIds.length > 50) {
      throw new ValidationError('لا يمكن تعيين أكثر من 50 مستخدماً لمهمة واحدة', { field: 'userIds', max: 50 });
    }

    // Validate assignedBy role is Manager or Admin
    const assigner = await db.prepare(
      "SELECT id, role FROM users WHERE id = ?"
    ).get(assignedBy) as any;

    if (!assigner) {
      throw new ForbiddenError('المستخدم المُعيِّن غير موجود');
    }

    const allowedRoles = [UserRole.MANAGER, UserRole.ADMIN];
    if (!allowedRoles.includes(assigner.role)) {
      throw new ForbiddenError('لا تملك صلاحية تعيين مستخدمين للمهام. يجب أن يكون دورك مدير أو مسؤول');
    }

    // Validate task exists
    const task = await db.prepare(
      "SELECT id FROM audit_tasks WHERE id = ?"
    ).get(taskId) as any;

    if (!task) {
      throw new NotFoundError('المهمة غير موجودة');
    }

    // Validate all user IDs exist
    const uniqueUserIds = [...new Set(userIds)];
    const placeholders = uniqueUserIds.map(() => '?').join(', ');
    const existingUsers = await db.prepare(
      `SELECT id FROM users WHERE id IN (${placeholders})`
    ).all(...uniqueUserIds) as any[];

    if (existingUsers.length !== uniqueUserIds.length) {
      const existingIds = new Set(existingUsers.map((u: any) => u.id));
      const missingIds = uniqueUserIds.filter(id => !existingIds.has(id));
      throw new ValidationError(
        'بعض معرّفات المستخدمين غير موجودة',
        { missingUserIds: missingIds }
      );
    }

    // Insert assignments within a single transaction
    const assignments = await db.transaction(async () => {
      const results: any[] = [];

      for (const userId of uniqueUserIds) {
        // Check for existing assignment (UNIQUE constraint)
        const existing = await db.prepare(
          "SELECT id FROM task_assignments WHERE task_id = ? AND user_id = ?"
        ).get(taskId, userId) as any;

        if (existing) {
          throw new ConflictError(`المستخدم ${userId} معيّن مسبقاً لهذه المهمة`);
        }

        const result = await db.prepare(
          `INSERT INTO task_assignments (task_id, user_id, assigned_by)
           VALUES (?, ?, ?)
           RETURNING id, task_id, user_id, assigned_at, assigned_by`
        ).get(taskId, userId, assignedBy) as any;

        results.push(result);
      }

      return results;
    });

    return { assignments };
  }

  /**
   * Removes a user assignment from a task.
   *
   * Validates:
   * - removedBy user has Manager or Admin role
   * - The assignment exists
   *
   * @param taskId - The task to unassign from
   * @param userId - The user to unassign
   * @param removedBy - The user performing the removal
   */
  static async unassignUser(taskId: string, userId: string, removedBy: string): Promise<{ success: boolean }> {
    // Validate removedBy role is Manager or Admin
    const remover = await db.prepare(
      "SELECT id, role FROM users WHERE id = ?"
    ).get(removedBy) as any;

    if (!remover) {
      throw new ForbiddenError('المستخدم غير موجود');
    }

    const allowedRoles = [UserRole.MANAGER, UserRole.ADMIN];
    if (!allowedRoles.includes(remover.role)) {
      throw new ForbiddenError('لا تملك صلاحية إزالة تعيين المستخدمين من المهام. يجب أن يكون دورك مدير أو مسؤول');
    }

    // Check assignment exists
    const assignment = await db.prepare(
      "SELECT id FROM task_assignments WHERE task_id = ? AND user_id = ?"
    ).get(taskId, userId) as any;

    if (!assignment) {
      throw new NotFoundError('التعيين غير موجود');
    }

    // Delete the assignment
    await db.prepare(
      "DELETE FROM task_assignments WHERE task_id = ? AND user_id = ?"
    ).run(taskId, userId);

    return { success: true };
  }

  /**
   * Gets all users assigned to a specific task.
   *
   * @param taskId - The task ID to get assignments for
   * @returns Array of assignment records with user details
   */
  static async getTaskAssignments(taskId: string): Promise<any[]> {
    const assignments = await db.prepare(
      `SELECT ta.id, ta.task_id, ta.user_id, ta.assigned_at, ta.assigned_by,
              u.name as user_name, u.username as user_username
       FROM task_assignments ta
       LEFT JOIN users u ON ta.user_id = u.id
       WHERE ta.task_id = ?
       ORDER BY ta.assigned_at ASC`
    ).all(taskId) as any[];

    return assignments;
  }

  static async getTasks(params: any = {}) {
    const { page, pageSize, offset } = parsePaginationParams(params);

    // Use COALESCE for task_type in case migration hasn't run yet
    let query = `
      SELECT t.id, t.title, t.task_number, t.status, t.due_date, t.assigned_to,
             t.audit_type, t.planned_hours, t.period_from, t.period_to,
             t.plan_id, t.audited_unit_id,
             p.title as plan_title, u.name as assigned_name, 
             e.name_en as audited_unit_name, e.name_ar as audited_unit_name_ar
      FROM audit_tasks t
      LEFT JOIN audit_plans p ON t.plan_id = p.id
      LEFT JOIN users u ON t.assigned_to = u.id
      LEFT JOIN org_entities e ON t.audited_unit_id = e.id
    `;
    
    let countQuery = "SELECT COUNT(*) as total FROM audit_tasks t";
    const args: any[] = [];
    let whereClause = "";

    if (params.plan_id) {
      whereClause = " WHERE t.plan_id = ?";
      args.push(params.plan_id);
    }

    query += whereClause + " ORDER BY t.created_at DESC LIMIT ? OFFSET ?";
    countQuery += whereClause;

    const [data, countRes] = await Promise.all([
      db.prepare(query).all(...args, pageSize, offset),
      db.prepare(countQuery).get(...args)
    ]) as [any[], any];

    const total = countRes?.total || 0;

    return {
      data,
      pagination: computePaginationMeta(page, pageSize, total)
    };
  }
}
