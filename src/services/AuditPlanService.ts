import { db } from '../db/index';
import { BaseService } from './BaseService';
import { NotificationService } from './NotificationService';
import { N8nService } from '../utils/n8nService';
import { NumberingService } from './NumberingService';
import { ValidationError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';

/** Valid quarter values for audit plans */
const VALID_QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4', 'Annual'] as const;
type Quarter = typeof VALID_QUARTERS[number];

export class AuditPlanService extends BaseService {
  /**
   * Checks whether a new plan can be created for the given fiscal year.
   *
   * Rules:
   * 1. No existing plan for the same fiscal year (regardless of status)
   * 2. Previous year's plan must be archived (if it exists)
   *
   * @param year - The fiscal year (e.g., 2025)
   * @returns Object with `allowed` boolean and optional `reason` string
   */
  static async canCreateNewPlan(year: number): Promise<{ allowed: boolean; reason?: string }> {
    // Check 1: No existing plan for the same fiscal year
    const sameYear = await db.prepare(
      "SELECT id FROM audit_plans WHERE year = ?"
    ).all(year) as any[];

    if (sameYear.length > 0) {
      return {
        allowed: false,
        reason: `توجد خطة للسنة المالية ${year} بالفعل`
      };
    }

    // Check 2: Previous year's plan must be archived (if it exists)
    const previousYear = year - 1;
    const unarchived = await db.prepare(
      "SELECT id, title FROM audit_plans WHERE year = ? AND is_archived = false"
    ).all(previousYear) as any[];

    if (unarchived.length > 0) {
      return {
        allowed: false,
        reason: `يجب أرشفة خطة السنة المالية ${previousYear} أولاً قبل إنشاء خطة جديدة`
      };
    }

    return { allowed: true };
  }

  /**
   * Returns the fixed fiscal year bounds (Jan 1 - Dec 31) for a given year.
   *
   * @param year - The fiscal year (e.g., 2025)
   * @returns Object with `start` (YYYY-01-01) and `end` (YYYY-12-31) date strings
   */
  static fiscalYearBounds(year: number): { start: string; end: string } {
    return {
      start: `${year}-01-01`,
      end: `${year}-12-31`,
    };
  }

  /**
   * Closes an audit plan after validating:
   * 1. The user has Manager or Admin role
   * 2. All recommendations linked to the plan's findings are 'Implemented' or 'Closed'
   *
   * @param planId - The ID of the plan to close
   * @param userId - The ID of the user requesting closure
   * @throws ForbiddenError if user lacks Manager/Admin role
   * @throws NotFoundError if plan does not exist
   * @throws ValidationError if open recommendations exist
   */
  static async closePlan(planId: string, userId: string): Promise<{ success: boolean; planId: string }> {
    // 1. Validate user role is Manager or Admin
    const user = await db.prepare(
      "SELECT id, role FROM users WHERE id = ?"
    ).get(userId) as any;

    if (!user) {
      throw new ForbiddenError('المستخدم غير موجود أو لا يملك الصلاحية');
    }

    const allowedRoles = ['Manager', 'Admin'];
    if (!allowedRoles.includes(user.role)) {
      throw new ForbiddenError('لا تملك صلاحية إغلاق الخطة. يجب أن يكون دورك مدير أو مسؤول');
    }

    // 2. Verify plan exists
    const plan = await db.prepare(
      "SELECT id, status FROM audit_plans WHERE id = ?"
    ).get(planId) as any;

    if (!plan) {
      throw new NotFoundError('الخطة غير موجودة');
    }

    // 3. Check all related recommendations are 'Implemented' or 'Closed'
    const openRecommendations = await db.prepare(
      `SELECT COUNT(*) as count FROM recommendations 
       WHERE finding_id IN (SELECT id FROM audit_findings WHERE audit_id = ?)
       AND status NOT IN ('Implemented', 'Closed')`
    ).get(planId) as any;

    const openCount = openRecommendations?.count || 0;

    if (openCount > 0) {
      throw new ValidationError(
        `لا يمكن إغلاق الخطة: توجد ${openCount} توصية غير مكتملة. يجب أن تكون جميع التوصيات بحالة "منفذة" أو "مغلقة"`,
        { openRecommendationsCount: openCount }
      );
    }

    // 4. Set plan status to 'Closed'
    await db.prepare(
      "UPDATE audit_plans SET status = 'Closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(planId);

    return { success: true, planId };
  }

  static async generatePlanCode(departmentName?: string): Promise<string> {
    const currentYear = new Date().getFullYear();
    const shortYear = currentYear.toString().slice(-2);
    
    // Attempt to resolve department code
    let deptCode = 'IA'; // Internal Audit by default
    if (departmentName) {
      try {
        const dept = await db.prepare("SELECT entity_code FROM org_entities WHERE name_ar = ? OR name_en = ?").get(departmentName, departmentName) as any;
        if (dept && dept.entity_code) {
          deptCode = dept.entity_code;
        }
      } catch (e) {
        // ignore
      }
    }

    const docType = 'PL'; // Plan
    const prefix = `${deptCode}-${docType}-${shortYear}-`;
    
    try {
      // Find the latest plan code with this format
      const latestPlan = await db.prepare(
        `SELECT plan_code FROM audit_plans 
         WHERE plan_code LIKE ? 
         ORDER BY plan_code DESC LIMIT 1`
      ).get(`${prefix}%`) as any;

      let nextNumber = 1;
      if (latestPlan && latestPlan.plan_code) {
        const parts = latestPlan.plan_code.split('-');
        const lastNumber = parseInt(parts[parts.length - 1]);
        if (!isNaN(lastNumber)) {
          nextNumber = lastNumber + 1;
        }
      }

      // Format with leading zeros (e.g., 001)
      const formattedNumber = nextNumber.toString().padStart(3, '0');
      const newCode = `${prefix}${formattedNumber}`;
      return newCode;
    } catch (error) {
      console.error('[AuditPlanService] Error generating plan code:', error);
      return `${prefix}ERR-${Date.now().toString().slice(-3)}`;
    }
  }

  /**
   * Creates a new audit plan with fiscal year validation, quarter enforcement,
   * single-plan-per-year constraint, and unified numbering via NumberingService.
   *
   * Validates:
   * - Year is within 2000-2100
   * - Quarter is one of: Q1, Q2, Q3, Q4, Annual
   * - No existing plan for the same fiscal year
   * - Previous year's plan is archived (if exists)
   * - Generates plan_code via NumberingService
   * - Sets default dates to fiscal year bounds
   * - Sets initial status to 'Planned'
   */
  static async create(tableName: string, data: any) {
    const year = data.year;
    const quarter = data.quarter || 'Annual';

    // Validate year range (2000-2100)
    if (year == null || !Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new ValidationError(
        'السنة المالية يجب أن تكون عدداً صحيحاً بين 2000 و 2100',
        { field: 'year', value: year }
      );
    }

    // Validate quarter value
    if (!VALID_QUARTERS.includes(quarter as Quarter)) {
      throw new ValidationError(
        `قيمة الربع غير صالحة. القيم المسموحة: ${VALID_QUARTERS.join(', ')}`,
        { field: 'quarter', value: quarter }
      );
    }

    // Enforce single plan per fiscal year and previous year archived
    const canCreate = await this.canCreateNewPlan(year);
    if (!canCreate.allowed) {
      throw new ConflictError(canCreate.reason!);
    }

    // Generate plan_code via NumberingService (unified hierarchical numbering)
    const planCode = await NumberingService.nextPlanCode(year);

    // Set fiscal year default dates
    const { start, end } = this.fiscalYearBounds(year);

    const body = {
      ...data,
      plan_code: planCode,
      year,
      quarter,
      planned_start_date: data.planned_start_date || start,
      planned_end_date: data.planned_end_date || end,
      status: 'Planned',
      is_archived: false,
    };

    const result = await super.create(tableName, body);
    
    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('audit_plan.created', {
      planId: result.id,
      title: body.title,
      department: body.department,
      planCode: body.plan_code
    });

    return result;
  }

  static async update(tableName: string, id: string | number, data: any) {
    // Get the current status before update
    const currentPlan = await db.prepare("SELECT status, title, lead_auditor FROM audit_plans WHERE id = ?").get(id) as any;
    
    const result = await super.update(tableName, id, data);

    // --- AUTOMATION: Send event to n8n ---
    if (data.status && currentPlan && currentPlan.status !== data.status) {
      await N8nService.sendEvent('audit_plan.status_changed', {
        planId: id,
        oldStatus: currentPlan.status,
        newStatus: data.status,
        title: data.title || currentPlan.title
      });
    }

    // --- AUTOMATION: Auto-generate report when audit plan is completed ---
    if (data.status === 'Completed' || data.status === 'Closed') {
      if (currentPlan && currentPlan.status !== data.status) {
        try {
          // Check if a report already exists for this audit
          const existingReport = await db.prepare("SELECT id FROM audit_reports WHERE audit_id = ?").get(id);
          
          if (!existingReport) {
            // Generate a new report
            const reportTitle = `Final Audit Report: ${data.title || currentPlan.title}`;
            const reportSummary = `This is an automatically generated final report for the audit engagement: ${data.title || currentPlan.title}. The audit has been marked as ${data.status}.`;
            
            await db.prepare(`
              INSERT INTO audit_reports (title, type, audit_id, summary, findings_included, status, created_by) 
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(reportTitle, 'Audit Report', id, reportSummary, 1, 'Final', 'System');

            await this.logAudit('System', `Auto-generated final report for Audit ID: ${id}`, "audit_reports", JSON.stringify({ title: reportTitle }));

            // Notify the lead auditor
            const leadAuditor = data.lead_auditor || currentPlan.lead_auditor;
            if (leadAuditor) {
              const user = await db.prepare("SELECT id FROM users WHERE name = ? OR username = ?").get(leadAuditor, leadAuditor) as any;
              if (user) {
                await NotificationService.create(
                  user.id,
                  'Report Auto-Generated',
                  `The final audit report for "${data.title || currentPlan.title}" has been automatically generated.`,
                  'audit_reports',
                  '/reports'
                );
              }
            }
          }
        } catch (err: any) {
          console.error('[Automation Error] Failed to auto-generate report:', err);
          
          try {
            // Un-silence the error by escalating it to the system error logs for Administrator visibility
            await db.prepare(`
              INSERT INTO system_error_log (user_id, module, url, message, stack, user_agent, request_data, severity)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              null, "AuditPlanService.update", "System_Job", 
              err?.message || "Unknown error generating report", err?.stack ? err.stack.substring(0, 2000) : "", 
              "System_Job", null, "error"
            );
          } catch (loggingErr) {
            console.error("Critical failure writing to system_error_log", loggingErr);
          }
        }
      }
    }
    // ------------------------------------------------------------------------

    return result;
  }
}
