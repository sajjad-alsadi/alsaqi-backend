import { db } from '../db/index';
import { N8nService } from '../utils/n8nService';
import { ValidationError, NotFoundError, ForbiddenError } from '../utils/errors';

/**
 * ArchiveService: Handles the full archive workflow for audit plans.
 *
 * The archive process:
 * 1. Validates user role (Manager/Admin)
 * 2. Validates plan exists and is not already archived
 * 3. Checks all tasks are 'completed', findings are 'Closed',
 *    recommendations are 'Implemented' or 'Closed'
 * 4. Copies plan, tasks, findings, recommendations, evidence to archive tables as JSONB
 * 5. Verifies copy completeness before deletion
 * 6. Deletes details from regular tables (evidence → recommendations → findings → tasks)
 * 7. Marks plan as is_archived = true, status = 'Archived'
 * 8. Sends audit_plan.archived event to N8nService with retry (up to 3 attempts)
 *
 * The entire operation runs within a single transaction.
 * On any failure, the transaction rolls back and data remains unchanged.
 */
export class ArchiveService {
  private static readonly MAX_N8N_RETRIES = 3;

  /**
   * Archives a plan and all its related data (tasks, findings, recommendations, evidence).
   *
   * @param planId - The ID of the plan to archive
   * @param userId - The ID of the user requesting the archive
   * @param userRole - The role of the user (must be 'Manager' or 'Admin')
   * @throws ForbiddenError if user doesn't have Manager/Admin role
   * @throws NotFoundError if plan doesn't exist or is already archived
   * @throws ValidationError if there are open tasks, findings, or recommendations
   */
  static async archivePlan(
    planId: string,
    userId: string,
    userRole: string
  ): Promise<void> {
    // 1. Validate user role
    const allowedRoles = ['Manager', 'Admin'];
    if (!allowedRoles.includes(userRole)) {
      throw new ForbiddenError('ليس لديك صلاحية الأرشفة. يجب أن تكون مديراً أو مسؤولاً.');
    }

    // Execute the entire archive operation within a single transaction
    await db.transaction(async () => {
      // 2. Validate plan exists and is not already archived
      const plan = await db.prepare(
        "SELECT * FROM audit_plans WHERE id = ? AND is_archived = false"
      ).get(planId) as any;

      if (!plan) {
        // Check if plan exists but is already archived
        const existingPlan = await db.prepare(
          "SELECT id, is_archived FROM audit_plans WHERE id = ?"
        ).get(planId) as any;

        if (existingPlan && existingPlan.is_archived) {
          throw new NotFoundError('الخطة مؤرشفة مسبقاً');
        }
        throw new NotFoundError('الخطة غير موجودة أو مؤرشفة مسبقاً');
      }

      // 3. Check all tasks are 'completed'
      const openTasks = await db.prepare(
        "SELECT COUNT(*) as count FROM audit_tasks WHERE plan_id = ? AND status != 'completed'"
      ).get(planId) as any;

      if (openTasks && Number(openTasks.count) > 0) {
        // Get detailed counts for the error message
        const taskDetails = await db.prepare(
          "SELECT status, COUNT(*) as count FROM audit_tasks WHERE plan_id = ? AND status != 'completed' GROUP BY status"
        ).all(planId) as any[];

        const detailStr = taskDetails
          .map((d: any) => `${d.count} مهمة بحالة "${d.status}"`)
          .join('، ');

        throw new ValidationError(
          `يجب إغلاق جميع المهام قبل الأرشفة. توجد عناصر مفتوحة: ${detailStr}`,
          { openTasks: Number(openTasks.count), details: taskDetails }
        );
      }

      // 4. Check all findings are 'Closed'
      const openFindings = await db.prepare(
        "SELECT COUNT(*) as count FROM audit_findings WHERE audit_id = ? AND status != 'Closed'"
      ).get(planId) as any;

      if (openFindings && Number(openFindings.count) > 0) {
        const findingDetails = await db.prepare(
          "SELECT status, COUNT(*) as count FROM audit_findings WHERE audit_id = ? AND status != 'Closed' GROUP BY status"
        ).all(planId) as any[];

        const detailStr = findingDetails
          .map((d: any) => `${d.count} ملاحظة بحالة "${d.status}"`)
          .join('، ');

        throw new ValidationError(
          `يجب إغلاق جميع الملاحظات قبل الأرشفة. توجد عناصر مفتوحة: ${detailStr}`,
          { openFindings: Number(openFindings.count), details: findingDetails }
        );
      }

      // 5. Check all recommendations are 'Implemented' or 'Closed'
      const openRecs = await db.prepare(
        `SELECT COUNT(*) as count FROM recommendations 
         WHERE finding_id IN (SELECT id FROM audit_findings WHERE audit_id = ?)
         AND status NOT IN ('Implemented', 'Closed')`
      ).get(planId) as any;

      if (openRecs && Number(openRecs.count) > 0) {
        const recDetails = await db.prepare(
          `SELECT status, COUNT(*) as count FROM recommendations 
           WHERE finding_id IN (SELECT id FROM audit_findings WHERE audit_id = ?)
           AND status NOT IN ('Implemented', 'Closed')
           GROUP BY status`
        ).all(planId) as any[];

        const detailStr = recDetails
          .map((d: any) => `${d.count} توصية بحالة "${d.status}"`)
          .join('، ');

        throw new ValidationError(
          `يجب إغلاق جميع التوصيات قبل الأرشفة. توجد عناصر مفتوحة: ${detailStr}`,
          { openRecommendations: Number(openRecs.count), details: recDetails }
        );
      }

      // --- Archive Operation ---

      // 6a. Copy plan to archived_plans
      await db.prepare(
        "INSERT INTO archived_plans (original_plan_id, plan_data, year, archived_by) VALUES (?, ?::jsonb, ?, ?)"
      ).run(planId, JSON.stringify(plan), plan.year, userId);

      // 6b. Copy tasks to archived_tasks
      const tasks = await db.prepare(
        "SELECT * FROM audit_tasks WHERE plan_id = ?"
      ).all(planId) as any[];

      for (const task of tasks) {
        await db.prepare(
          "INSERT INTO archived_tasks (original_task_id, plan_id, task_data) VALUES (?, ?, ?::jsonb)"
        ).run(task.id, planId, JSON.stringify(task));
      }

      // 6c. Copy findings to archived_findings
      const findings = await db.prepare(
        "SELECT * FROM audit_findings WHERE audit_id = ?"
      ).all(planId) as any[];

      for (const finding of findings) {
        await db.prepare(
          "INSERT INTO archived_findings (original_finding_id, plan_id, finding_data) VALUES (?, ?, ?::jsonb)"
        ).run(finding.id, planId, JSON.stringify(finding));
      }

      // 6d. Copy recommendations to archived_recommendations
      const recs = await db.prepare(
        `SELECT r.* FROM recommendations r
         JOIN audit_findings f ON r.finding_id = f.id
         WHERE f.audit_id = ?`
      ).all(planId) as any[];

      for (const rec of recs) {
        await db.prepare(
          "INSERT INTO archived_recommendations (original_recommendation_id, plan_id, recommendation_data) VALUES (?, ?, ?::jsonb)"
        ).run(rec.id, planId, JSON.stringify(rec));
      }

      // 6e. Copy evidence to archived_evidence
      const evidence = await db.prepare(
        "SELECT * FROM audit_evidence WHERE audit_id = ?"
      ).all(planId) as any[];

      for (const ev of evidence) {
        await db.prepare(
          "INSERT INTO archived_evidence (original_evidence_id, plan_id, evidence_data) VALUES (?, ?, ?::jsonb)"
        ).run(ev.id, planId, JSON.stringify(ev));
      }

      // 7. Verify copy completeness before deletion
      const archivedTaskCount = await db.prepare(
        "SELECT COUNT(*) as count FROM archived_tasks WHERE plan_id = ?"
      ).get(planId) as any;

      const archivedFindingCount = await db.prepare(
        "SELECT COUNT(*) as count FROM archived_findings WHERE plan_id = ?"
      ).get(planId) as any;

      const archivedRecCount = await db.prepare(
        "SELECT COUNT(*) as count FROM archived_recommendations WHERE plan_id = ?"
      ).get(planId) as any;

      const archivedEvidenceCount = await db.prepare(
        "SELECT COUNT(*) as count FROM archived_evidence WHERE plan_id = ?"
      ).get(planId) as any;

      if (Number(archivedTaskCount.count) !== tasks.length) {
        throw new Error('فشل التحقق من اكتمال نسخ المهام إلى الأرشيف');
      }
      if (Number(archivedFindingCount.count) !== findings.length) {
        throw new Error('فشل التحقق من اكتمال نسخ الملاحظات إلى الأرشيف');
      }
      if (Number(archivedRecCount.count) !== recs.length) {
        throw new Error('فشل التحقق من اكتمال نسخ التوصيات إلى الأرشيف');
      }
      if (Number(archivedEvidenceCount.count) !== evidence.length) {
        throw new Error('فشل التحقق من اكتمال نسخ الأدلة إلى الأرشيف');
      }

      // 8. Delete details from regular tables (respecting FK constraints)
      // Order: evidence → recommendations → findings → tasks
      await db.prepare(
        "DELETE FROM audit_evidence WHERE audit_id = ?"
      ).run(planId);

      await db.prepare(
        `DELETE FROM recommendations 
         WHERE finding_id IN (SELECT id FROM audit_findings WHERE audit_id = ?)`
      ).run(planId);

      await db.prepare(
        "DELETE FROM audit_findings WHERE audit_id = ?"
      ).run(planId);

      await db.prepare(
        "DELETE FROM audit_tasks WHERE plan_id = ?"
      ).run(planId);

      // 9. Mark plan as archived (plan row stays for quick lookup)
      await db.prepare(
        "UPDATE audit_plans SET is_archived = true, archived_at = CURRENT_TIMESTAMP, archived_by = ?, status = 'Archived' WHERE id = ?"
      ).run(userId, planId);
    });

    // 10. Send automation event (outside transaction - archive stays even if this fails)
    await this.sendArchiveEventWithRetry(planId, userId);
  }

  /**
   * Sends the audit_plan.archived event to N8nService with retry logic.
   * Up to 3 attempts. If all fail, the archive remains intact (no rollback).
   */
  private static async sendArchiveEventWithRetry(
    planId: string,
    userId: string
  ): Promise<void> {
    // Fetch the plan year for the event payload
    const plan = await db.prepare(
      "SELECT year FROM audit_plans WHERE id = ?"
    ).get(planId) as any;

    const payload = {
      planId,
      year: plan?.year,
      archivedBy: userId,
    };

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.MAX_N8N_RETRIES; attempt++) {
      try {
        await N8nService.sendEvent('audit_plan.archived', payload);
        return; // Success
      } catch (error: any) {
        lastError = error;
        console.error(
          `[ArchiveService] Failed to send audit_plan.archived event (attempt ${attempt}/${this.MAX_N8N_RETRIES}):`,
          error?.message
        );

        // Wait before retry (exponential backoff: 1s, 2s, 4s)
        if (attempt < this.MAX_N8N_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt - 1) * 1000));
        }
      }
    }

    // All retries failed - log but don't throw (archive is already complete)
    console.error(
      `[ArchiveService] All ${this.MAX_N8N_RETRIES} attempts to send audit_plan.archived event failed.`,
      lastError?.message
    );
  }
}
