import cron from 'node-cron';
import { db } from '../db/index';
import logger from '../utils/logger';
import { NotificationService } from '../services/NotificationService';
import { UserRole } from '@alsaqi/shared';
import { backupScheduler } from '../utils/backup';
import { updateCronLastRun } from '../routes/health';
import { partitionManager } from '../services/PartitionManager';

export const startAutomationJobs = () => {
  logger.info('[CRON] Starting automation jobs...');

  // Run every day at midnight (0 0 * * *)
  // For testing purposes, we could run it more frequently, but daily is standard.
  cron.schedule('0 0 * * *', async () => {
    logger.info('[CRON] Running daily automation tasks...');
    try {
      await runDailyAutomations();
    } catch (error) {
      logger.error('[CRON] Error running daily automations:', error);
    }
    try {
      await checkUpcomingDeadlines();
    } catch (error) {
      logger.error('[CRON] Error running deadline checks:', error);
    }
  });

  // Daily backup at 2:00 AM via BackupScheduler (default schedule: '0 2 * * *')
  backupScheduler.start();

  // Monthly partition maintenance (1st of each month at midnight)
  // Creates future partitions (3 months ahead) and drops old ones based on retention policy
  partitionManager.scheduleMaintenanceJob();

  // Run immediately on startup to catch up
  runDailyAutomations().catch(err => {
    logger.error('[CRON] Error running initial automations:', err);
  });

  // Run deadline checks on startup (with once-per-day guard)
  checkUpcomingDeadlines().catch(err => {
    logger.error('[CRON] Error running initial deadline checks:', err);
  });
};

const runDailyAutomations = async () => {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  
  logger.info(`[CRON] Executing automations for date: ${todayStr}`);

  // 1. Auto-Status Update for Audit Plans (Planned -> In Progress)
  try {
    const plansToUpdate = await db.prepare(`
      SELECT id, title, lead_auditor 
      FROM audit_plans 
      WHERE status = 'Planned' AND planned_start_date <= ?
    `).all(todayStr);

    if (plansToUpdate && plansToUpdate.length > 0) {
      logger.info(`[CRON] Found ${plansToUpdate.length} audit plans to start.`);
      
      const updateStmt = await db.prepare(`
        UPDATE audit_plans 
        SET status = 'In Progress' 
        WHERE status = 'Planned' AND planned_start_date <= ?
      `);
      await updateStmt.run(todayStr);

      // Notify lead auditors
      for (const plan of plansToUpdate) {
        if (plan.lead_auditor) {
          // Find user ID for lead auditor
          const user = await db.prepare(`SELECT id FROM users WHERE name = ? OR username = ?`).get(plan.lead_auditor, plan.lead_auditor);
          if (user) {
            await NotificationService.create(
              user.id,
              'plan_started',
              `The audit plan "${plan.title}" has automatically started today.`,
              'info',
              `/plan`
            );
          }
        }
      }
    }
  } catch (err) {
    logger.error('[CRON] Error updating audit plans:', err);
  }

  // 2. Auto-Status Update for Recommendations (Open/In Progress -> Overdue)
  // Optimized: single JOIN query, bulk UPDATE, grouped notifications per user
  try {
    // Single JOIN query to get overdue recommendations with resolved user info
    const overdueWithUsers = await db.prepare(`
      SELECT r.id, r.responsible, r.finding_id, u.id as user_id
      FROM recommendations r
      LEFT JOIN users u ON (u.name = r.responsible OR u.username = r.responsible)
      WHERE r.status IN ('Open', 'In Progress') AND r.due_date < ?
    `).all(todayStr) as Array<{ id: string; responsible: string; finding_id: string; user_id: string | null }>;

    if (overdueWithUsers && overdueWithUsers.length > 0) {
      logger.info(`[CRON] Found ${overdueWithUsers.length} overdue recommendations.`);

      // Single bulk UPDATE for all overdue recommendations
      await db.prepare(`
        UPDATE recommendations 
        SET status = 'Overdue' 
        WHERE status IN ('Open', 'In Progress') AND due_date < ?
      `).run(todayStr);

      // Group notifications by user (one notification per user with count)
      // Skip records where responsible doesn't resolve to a valid user
      const userNotifications = new Map<string, number>();
      for (const rec of overdueWithUsers) {
        if (rec.user_id) {
          userNotifications.set(
            rec.user_id,
            (userNotifications.get(rec.user_id) || 0) + 1
          );
        }
      }

      // Send one notification per user with their overdue count
      for (const [userId, count] of userNotifications) {
        await NotificationService.create(
          userId,
          'recommendation_overdue',
          JSON.stringify({ key: 'notifications.recommendationsOverdue', params: { count } }),
          'warning',
          '/recommendations'
        );
      }

      logger.info(`[CRON] Sent overdue notifications to ${userNotifications.size} users.`);
    }
  } catch (err) {
    logger.error('[CRON] Error updating overdue recommendations:', { error: err, date: todayStr });
    // Abort: do not send partial notifications — error is logged with context
  }

  // 3. Smart Escalation (Reminders for upcoming recommendations - 7 days before)
  try {
    const nextWeek = new Date(now);
    nextWeek.setDate(now.getDate() + 7);
    const nextWeekStr = nextWeek.toISOString().split('T')[0];

    const upcomingRecs = await db.prepare(`
      SELECT id, responsible 
      FROM recommendations 
      WHERE status IN ('Open', 'In Progress') AND due_date = ?
    `).all(nextWeekStr);

    if (upcomingRecs && upcomingRecs.length > 0) {
      logger.info(`[CRON] Found ${upcomingRecs.length} recommendations due in 7 days.`);
      
      for (const rec of upcomingRecs) {
        if (rec.responsible) {
          const user = await db.prepare(`SELECT id FROM users WHERE name = ? OR username = ?`).get(rec.responsible, rec.responsible);
          if (user) {
            await NotificationService.create(
              user.id,
              'recommendation_due_soon',
              `A recommendation assigned to you is due in 7 days.`,
              'info',
              `/recommendations`
            );
          }
        }
      }
    }
  } catch (err) {
    logger.error('[CRON] Error sending upcoming recommendation reminders:', err);
  }

  // 4. Compliance Automation: Flag overdue central bank instructions
  try {
    const overdueInstructions = await db.prepare(`
      SELECT id, title, related_department 
      FROM central_bank_instructions 
      WHERE status IN ('Draft', 'Under Review') AND issue_date < ?
    `).all(todayStr);

    if (overdueInstructions && overdueInstructions.length > 0) {
      logger.info(`[CRON] Found ${overdueInstructions.length} overdue central bank instructions.`);
      
      const updateStmt = await db.prepare(`
        UPDATE central_bank_instructions 
        SET status = 'Overdue' 
        WHERE status IN ('Draft', 'Under Review') AND issue_date < ?
      `);
      await updateStmt.run(todayStr);

      // Notify department heads or compliance officers
      // For now, notify all admins
      const admins = await db.prepare(`SELECT id FROM users WHERE role IN ('${UserRole.ADMIN}')`).all();
      for (const admin of admins) {
        await NotificationService.create(
          admin.id,
          'instruction_overdue',
          `Central Bank Instruction(s) have become overdue. Please review.`,
          'warning',
          `/regulatory`
        );
      }
    }
  } catch (err) {
    logger.error('[CRON] Error updating central bank instructions:', err);
  }

  // 5. Policy Automation: Periodic review reminders (e.g., 1 year since upload)
  try {
    const lastYear = new Date(now);
    lastYear.setFullYear(now.getFullYear() - 1);
    const lastYearStr = lastYear.toISOString().split('T')[0];

    const policiesToReview = await db.prepare(`
      SELECT id, title, department 
      FROM internal_policies 
      WHERE status = 'active' AND upload_date <= ?
    `).all(lastYearStr);

    if (policiesToReview && policiesToReview.length > 0) {
      logger.info(`[CRON] Found ${policiesToReview.length} policies requiring annual review.`);
      
      const updateStmt = await db.prepare(`
        UPDATE internal_policies 
        SET status = 'needs_review' 
        WHERE status = 'active' AND upload_date <= ?
      `);
      await updateStmt.run(lastYearStr);

      const admins = await db.prepare(`SELECT id FROM users WHERE role IN ('${UserRole.ADMIN}')`).all();
      for (const admin of admins) {
        await NotificationService.create(
          admin.id,
          'policy_review_required',
          `${policiesToReview.length} internal policies have reached their 1-year review mark.`,
          'info',
          `/legal`
        );
      }
    }
  } catch (err) {
    logger.error('[CRON] Error updating internal policies:', err);
  }

  // 6. Audit Tasks — Deadline approaching (3 days before due_date)
  try {
    const threeDaysLater = new Date(now);
    threeDaysLater.setDate(now.getDate() + 3);
    const threeDaysStr = threeDaysLater.toISOString().split('T')[0];

    const upcomingTasks = await db.prepare(`
      SELECT id, title, assigned_to, due_date
      FROM audit_tasks 
      WHERE status NOT IN ('completed', 'cancelled') 
        AND due_date = ? 
        AND deleted_at IS NULL
        AND assigned_to IS NOT NULL
    `).all(threeDaysStr);

    if (upcomingTasks && upcomingTasks.length > 0) {
      logger.info(`[CRON] Found ${upcomingTasks.length} tasks due in 3 days.`);
      
      for (const task of upcomingTasks) {
        await NotificationService.create(
          task.assigned_to,
          'task_status_changed',
          JSON.stringify({ key: 'notifications.taskDeadlineNear', params: { title: task.title, date: task.due_date } }),
          'AuditTasks',
          `/tasks`,
          { entityId: task.id, entityType: 'audit_task', title: JSON.stringify({ key: 'notifications.taskDeadlineNear' }) }
        );
      }
    }
  } catch (err) {
    logger.error('[CRON] Error sending task deadline reminders:', err);
  }

  logger.info('[CRON] Daily automations completed.');
  updateCronLastRun();
};

// ─── Deadline Notification Helpers (exported for testing) ────────────────────

/** Track last run date to ensure once-per-day execution */
let lastDeadlineCheckDate: string | null = null;

/**
 * Get Manager/Admin user IDs.
 */
export async function getManagerAdminIds(): Promise<string[]> {
  const users = await db.prepare(
    `SELECT id FROM users WHERE role IN ('${UserRole.ADMIN}', '${UserRole.MANAGER}') AND status = 'active'`
  ).all() as any[];
  return users.map((u: any) => u.id);
}

/**
 * Determine which tasks are due tomorrow (today + 1 day) and not completed/approved.
 * Returns the assigned user IDs for each task via task_assignments.
 */
export async function getTasksDueTomorrow(todayStr: string): Promise<Array<{ taskId: string; title: string; dueDate: string; assignedUserIds: string[] }>> {
  const tomorrow = new Date(todayStr);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const tasks = await db.prepare(`
    SELECT t.id, t.title, t.due_date
    FROM audit_tasks t
    WHERE t.due_date = ?
      AND t.status NOT IN ('completed', 'approved')
      AND (t.deleted_at IS NULL)
  `).all(tomorrowStr) as any[];

  const results: Array<{ taskId: string; title: string; dueDate: string; assignedUserIds: string[] }> = [];

  for (const task of tasks) {
    const assignments = await db.prepare(
      `SELECT user_id FROM task_assignments WHERE task_id = ?`
    ).all(task.id) as any[];

    const assignedUserIds = assignments.map((a: any) => a.user_id);
    if (assignedUserIds.length > 0) {
      results.push({
        taskId: task.id,
        title: task.title,
        dueDate: task.due_date,
        assignedUserIds,
      });
    }
  }

  return results;
}

/**
 * Determine which plans have start/end dates 3 days from today and are not archived.
 * Returns plan info with lead_auditor (may be null).
 */
export async function getPlansDueIn3Days(todayStr: string): Promise<Array<{ planId: string; title: string; dateType: 'start' | 'end'; date: string; leadAuditor: string | null }>> {
  const threeDaysLater = new Date(todayStr);
  threeDaysLater.setDate(threeDaysLater.getDate() + 3);
  const threeDaysStr = threeDaysLater.toISOString().split('T')[0];

  const plans = await db.prepare(`
    SELECT id, title, planned_start_date, planned_end_date, lead_auditor
    FROM audit_plans
    WHERE is_archived = false
      AND (planned_start_date = ? OR planned_end_date = ?)
  `).all(threeDaysStr, threeDaysStr) as any[];

  const results: Array<{ planId: string; title: string; dateType: 'start' | 'end'; date: string; leadAuditor: string | null }> = [];

  for (const plan of plans) {
    if (plan.planned_start_date === threeDaysStr) {
      results.push({
        planId: plan.id,
        title: plan.title,
        dateType: 'start',
        date: plan.planned_start_date,
        leadAuditor: plan.lead_auditor || null,
      });
    }
    if (plan.planned_end_date === threeDaysStr) {
      results.push({
        planId: plan.id,
        title: plan.title,
        dateType: 'end',
        date: plan.planned_end_date,
        leadAuditor: plan.lead_auditor || null,
      });
    }
  }

  return results;
}

/**
 * Check if unarchived plans exist for the current year (used for Dec 15 reminder).
 */
export async function getUnarchivedPlansForYear(year: number): Promise<Array<{ id: string; title: string }>> {
  const plans = await db.prepare(
    `SELECT id, title FROM audit_plans WHERE year = ? AND is_archived = false`
  ).all(year) as any[];
  return plans;
}

/**
 * Resolve lead auditor name to user ID. Returns null if not found.
 */
export async function resolveLeadAuditorId(leadAuditor: string | null): Promise<string | null> {
  if (!leadAuditor) return null;
  const user = await db.prepare(
    `SELECT id FROM users WHERE (name = ? OR username = ?) AND status = 'active'`
  ).get(leadAuditor, leadAuditor) as any;
  return user?.id || null;
}

/**
 * Main deadline checking function. Runs once per calendar day.
 * 
 * 1. Task due date notifications: 1 day before → notify all assigned users (via task_assignments)
 * 2. Plan date notifications: 3 days before start/end → notify Manager/Admin + lead auditor
 * 3. Year-end reminder: December 15 → notify Manager/Admin if unarchived plan exists
 */
export async function checkUpcomingDeadlines(dateOverride?: string): Promise<void> {
  const now = new Date();
  const todayStr = dateOverride || now.toISOString().split('T')[0];

  // Once-per-day guard: skip if already ran today
  if (lastDeadlineCheckDate === todayStr) {
    logger.info(`[CRON:Deadlines] Already ran for ${todayStr}, skipping.`);
    return;
  }

  logger.info(`[CRON:Deadlines] Running deadline checks for ${todayStr}...`);

  // 1. Task due date notifications (due_date = today + 1 day, status not completed/approved)
  try {
    const tasksDue = await getTasksDueTomorrow(todayStr);
    if (tasksDue.length > 0) {
      logger.info(`[CRON:Deadlines] Found ${tasksDue.length} tasks due tomorrow.`);
      for (const task of tasksDue) {
        await NotificationService.create(
          task.assignedUserIds,
          'task_status_changed',
          JSON.stringify({ key: 'notifications.taskDueTomorrow', params: { title: task.title, dueDate: task.dueDate } }),
          'AuditTasks',
          '/tasks',
          { entityId: task.taskId, entityType: 'audit_task' }
        );
      }
    }
  } catch (err) {
    logger.error('[CRON:Deadlines] Error checking task deadlines:', err);
  }

  // 2. Plan date notifications (start/end date = today + 3 days, not archived)
  try {
    const plansDue = await getPlansDueIn3Days(todayStr);
    if (plansDue.length > 0) {
      logger.info(`[CRON:Deadlines] Found ${plansDue.length} plan date(s) in 3 days.`);
      const managerAdminIds = await getManagerAdminIds();

      for (const plan of plansDue) {
        const recipientIds = [...managerAdminIds];
        let missingLeadAuditor = false;

        // Resolve lead auditor and add to recipients
        const leadAuditorId = await resolveLeadAuditorId(plan.leadAuditor);
        if (leadAuditorId) {
          if (!recipientIds.includes(leadAuditorId)) {
            recipientIds.push(leadAuditorId);
          }
        } else {
          missingLeadAuditor = true;
        }

        const messageKey = plan.dateType === 'start'
          ? 'notifications.planStartingSoon'
          : 'notifications.planEndingSoon';

        await NotificationService.create(
          recipientIds,
          'plan_status_changed',
          JSON.stringify({
            key: messageKey,
            params: {
              title: plan.title,
              date: plan.date,
              missingLeadAuditor,
            },
          }),
          'AuditPlans',
          '/plan',
          { entityId: plan.planId, entityType: 'audit_plan' }
        );
      }
    }
  } catch (err) {
    logger.error('[CRON:Deadlines] Error checking plan deadlines:', err);
  }

  // 3. Year-end reminder: December 15 → notify Manager/Admin if unarchived plan exists
  try {
    const month = now.getMonth(); // 0-indexed: 11 = December
    const day = now.getDate();
    const currentYear = now.getFullYear();

    // Use dateOverride for testing if provided
    const checkMonth = dateOverride ? new Date(dateOverride).getMonth() : month;
    const checkDay = dateOverride ? new Date(dateOverride).getDate() : day;
    const checkYear = dateOverride ? new Date(dateOverride).getFullYear() : currentYear;

    if (checkMonth === 11 && checkDay === 15) { // December 15
      const unarchivedPlans = await getUnarchivedPlansForYear(checkYear);
      if (unarchivedPlans.length > 0) {
        logger.info(`[CRON:Deadlines] Dec 15 reminder: ${unarchivedPlans.length} unarchived plan(s) for ${checkYear}.`);
        const managerAdminIds = await getManagerAdminIds();

        await NotificationService.create(
          managerAdminIds,
          'plan_status_changed',
          JSON.stringify({
            key: 'notifications.yearEndArchiveReminder',
            params: {
              year: checkYear,
              planCount: unarchivedPlans.length,
              planTitles: unarchivedPlans.map(p => p.title).join(', '),
            },
          }),
          'AuditPlans',
          '/plan'
        );
      }
    }
  } catch (err) {
    logger.error('[CRON:Deadlines] Error checking year-end reminder:', err);
  }

  // Mark as completed for today
  lastDeadlineCheckDate = todayStr;
  logger.info(`[CRON:Deadlines] Deadline checks completed for ${todayStr}.`);
}

/** Reset the last deadline check date (for testing purposes) */
export function resetDeadlineCheckDate(): void {
  lastDeadlineCheckDate = null;
}

/** Get the last deadline check date (for testing purposes) */
export function getLastDeadlineCheckDate(): string | null {
  return lastDeadlineCheckDate;
}
