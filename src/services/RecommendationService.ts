import { db } from '../db/index';
import { NotFoundError, ValidationError } from '../utils/errors';
import { NotificationService } from './NotificationService';
import { N8nService } from '../utils/n8nService';
import { AuditChainService } from './AuditChainService';

export interface RecommendationFilters {
  department?: string;
  plan_id?: string;
  status?: string;
  page?: number | string;
  pageSize?: number | string;
}

export class RecommendationService {
  /**
   * Returns recommendations as a bounded list.
   *
   * Excludes soft-deleted rows (finding 1.31 → 2.31) and is bounded by a default
   * limit to prevent unbounded result sets / DoS (finding 1.33 → 2.33). Callers
   * may pass an explicit limit (clamped to a 500-row maximum).
   */
  static async getAll(limit = 200) {
    const safeLimit = Math.min(Math.max(parseInt(String(limit)) || 200, 1), 500);
    return await db
      .prepare("SELECT * FROM recommendations WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?")
      .all(safeLimit);
  }

  /**
   * Returns paginated recommendations matching the given filters.
   *
   * Filters:
   * - department: filter by department
   * - plan_id: filter by plan_id
   * - status: filter by status
   * - page: page number (default 1)
   * - pageSize: items per page (default 20, max 100)
   *
   * Excludes recommendations from archived plans (WHERE plan_id NOT IN archived plans).
   *
   * @param filters - The filter criteria
   * @returns Paginated results with data and pagination metadata
   */
  static async getRecommendations(filters: RecommendationFilters = {}): Promise<{
    data: any[];
    pagination: { total: number; page: number; pageSize: number; totalPages: number };
  }> {
    const page = Math.max(1, parseInt(String(filters.page)) || 1);
    let pageSize = parseInt(String(filters.pageSize)) || 20;
    // Enforce max pageSize of 100
    if (pageSize > 100) {
      pageSize = 100;
    }
    if (pageSize < 1) {
      pageSize = 20;
    }
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const args: any[] = [];

    // Exclude soft-deleted recommendations (finding 1.31 → 2.31).
    conditions.push("deleted_at IS NULL");

    // Exclude recommendations from archived plans
    conditions.push("plan_id NOT IN (SELECT id FROM audit_plans WHERE is_archived = true)");

    if (filters.department) {
      conditions.push("department = ?");
      args.push(filters.department);
    }

    if (filters.plan_id) {
      conditions.push("plan_id = ?");
      args.push(filters.plan_id);
    }

    if (filters.status) {
      conditions.push("status = ?");
      args.push(filters.status);
    }

    const whereClause = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";

    const countQuery = "SELECT COUNT(*) as total FROM recommendations" + whereClause;
    const dataQuery = "SELECT * FROM recommendations" + whereClause + " ORDER BY created_at DESC LIMIT ? OFFSET ?";

    const [countRes, data] = await Promise.all([
      db.prepare(countQuery).get(...args),
      db.prepare(dataQuery).all(...args, pageSize, offset),
    ]) as [any, any[]];

    const total = countRes?.total || 0;

    return {
      data,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  static async update(id: string | number, data: any, username: string) {
    const body = { ...data };
    delete body.id;

    const keys = Object.keys(body).map(k => db.validateIdentifier(k));
    const values = Object.values(body);
    
    if (keys.length === 0) {
      throw new ValidationError("No data provided for update");
    }

    const setClause = keys.map(k => `${k} = ?`).join(",");

    // Collected inside the transaction for post-commit side effects.
    let autoClosedFinding: { id: string; title: string; audit_id: string } | null = null;

    // Wrap the recommendation update together with the cascading finding
    // auto-close DB writes in a single transaction so a partial write (the
    // recommendation updated but the finding left open, or vice versa) can never
    // persist (finding 1.13 → 2.13).
    //
    // Audit-chain appends and n8n webhooks are intentionally kept OUTSIDE this
    // transaction and dispatched after commit: AuditChainService.append opens
    // its own db.transaction and the helper does not support nesting (an inner
    // BEGIN/COMMIT would prematurely commit the outer transaction), and external
    // webhooks must not run inside the DB transaction (finding 1.14 → 2.14).
    await db.transaction(async () => {
      await db.prepare(`UPDATE recommendations SET ${setClause} WHERE id = ?`).run(...values, id);

      // --- Cascade: auto-close finding if all recommendations are implemented ---
      if (body.status === 'Implemented') {
        // Get the finding_id for this recommendation
        const rec = await db.prepare("SELECT finding_id FROM recommendations WHERE id = ?").get(id) as any;
        if (rec && rec.finding_id) {
          // Check if there are any recommendations for this finding that are NOT 'Implemented'
          const openRecs = await db.prepare("SELECT COUNT(*) as count FROM recommendations WHERE finding_id = ? AND status != 'Implemented'").get(rec.finding_id);

          if (openRecs && (openRecs as any).count === 0) {
            // Check if finding is already closed
            const finding = await db.prepare("SELECT status, audit_id, title FROM audit_findings WHERE id = ?").get(rec.finding_id) as any;

            if (finding && finding.status !== 'Closed') {
              // All recommendations are implemented, so close the finding
              await db.prepare("UPDATE audit_findings SET status = 'Closed' WHERE id = ?").run(rec.finding_id);
              autoClosedFinding = { id: rec.finding_id, title: finding.title, audit_id: finding.audit_id };
            }
          }
        }
      }
    });

    // --- Post-commit: audit chain append for the recommendation update ---
    await AuditChainService.append({
      user: username,
      action: `Updated recommendations ID: ${id}`,
      module: 'recommendations',
      details: JSON.stringify(body),
    });

    // --- AUTOMATION: Send event to n8n (after commit, outside transaction) ---
    await N8nService.sendEvent('recommendation.updated', {
      recommendationId: id,
      newStatus: body.status,
      updatedBy: username,
      dueDate: body.due_date
    });

    // --- Post-commit side effects for the auto-closed finding ---
    if (autoClosedFinding) {
      const closed: { id: string; title: string; audit_id: string } = autoClosedFinding;
      try {
        await AuditChainService.append({
          user: 'System',
          action: `Auto-closed finding ID: ${closed.id} as all recommendations are implemented`,
          module: 'audit_findings',
          details: JSON.stringify({ status: 'Closed' }),
        });

        // --- AUTOMATION: Send event to n8n ---
        await N8nService.sendEvent('finding.auto_closed', {
          findingId: closed.id,
          title: closed.title,
          auditId: closed.audit_id
        });

        // Get lead auditor to notify
        if (closed.audit_id) {
          const plan = await db.prepare("SELECT lead_auditor FROM audit_plans WHERE id = ?").get(closed.audit_id) as any;
          if (plan && plan.lead_auditor) {
            const user = await db.prepare("SELECT id FROM users WHERE name = ? OR username = ?").get(plan.lead_auditor, plan.lead_auditor) as any;
            if (user) {
              await NotificationService.create(
                user.id,
                'Finding Auto-Closed',
                `The finding "${closed.title}" has been automatically closed because all its recommendations are now implemented.`,
                'audit_findings',
                '/findings'
              );
            }
          }
        }
      } catch (err) {
        console.error('[Automation Error] Failed to dispatch auto-close side effects:', err);
      }
    }
    // ------------------------------------------------------------------------

    return { id, ...body };
  }
}
