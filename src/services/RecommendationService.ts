import { db } from '../db/index';
import { NotFoundError, ValidationError } from '../utils/errors';
import { NotificationService } from './NotificationService';
import { N8nService } from '../utils/n8nService';

export interface RecommendationFilters {
  department?: string;
  plan_id?: string;
  status?: string;
  page?: number | string;
  pageSize?: number | string;
}

export class RecommendationService {
  static async getAll() {
    return await db.prepare("SELECT * FROM recommendations").all();
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
    await db.prepare(`UPDATE recommendations SET ${setClause} WHERE id = ?`).run(...values, id);

    await db.prepare("INSERT INTO audit_trail (user, action, module, details) VALUES (?::text, ?::text, ?::text, ?::text)")
      .run(username, `Updated recommendations ID: ${id}`, "recommendations", JSON.stringify(body));

    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('recommendation.updated', {
      recommendationId: id,
      newStatus: body.status,
      updatedBy: username,
      dueDate: body.due_date
    });

    // --- AUTOMATION: Auto-close finding if all recommendations are implemented ---
    if (body.status === 'Implemented') {
      try {
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
              
              await db.prepare("INSERT INTO audit_trail (user, action, module, details) VALUES (?::text, ?::text, ?::text, ?::text)")
                .run('System', `Auto-closed finding ID: ${rec.finding_id} as all recommendations are implemented`, "audit_findings", JSON.stringify({ status: 'Closed' }));

              // --- AUTOMATION: Send event to n8n ---
              await N8nService.sendEvent('finding.auto_closed', {
                findingId: rec.finding_id,
                title: finding.title,
                auditId: finding.audit_id
              });

              // Get lead auditor to notify
              if (finding.audit_id) {
                const plan = await db.prepare("SELECT lead_auditor FROM audit_plans WHERE id = ?").get(finding.audit_id) as any;
                if (plan && plan.lead_auditor) {
                  const user = await db.prepare("SELECT id FROM users WHERE name = ? OR username = ?").get(plan.lead_auditor, plan.lead_auditor) as any;
                  if (user) {
                    await NotificationService.create(
                      user.id,
                      'Finding Auto-Closed',
                      `The finding "${finding.title}" has been automatically closed because all its recommendations are now implemented.`,
                      'audit_findings',
                      '/findings'
                    );
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('[Automation Error] Failed to auto-close finding:', err);
      }
    }
    // ------------------------------------------------------------------------

    return { id, ...body };
  }
}
