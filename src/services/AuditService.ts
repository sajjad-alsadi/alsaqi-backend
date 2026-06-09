import { db } from '../db/index';
import { ValidationError, NotFoundError, ForbiddenError } from '../utils/errors';
import { N8nService } from '../utils/n8nService';
import { NumberingService } from './NumberingService';
import { NotificationService } from './NotificationService';
import { UserRole, ADMIN_ROLES } from '../constants.js';
import { DEFAULT_PERMISSIONS, MODULES, PERMISSIONS } from '../permissions.js';
import type { Role } from '../permissions.js';

const VALID_FINDING_TYPES = ['control_design_deficiency', 'operational_design_deficiency'] as const;
type FindingType = typeof VALID_FINDING_TYPES[number];

/** Allowed finding status transitions */
export const ALLOWED_FINDING_TRANSITIONS: Record<string, string[]> = {
  'Open': ['In Progress'],
  'In Progress': ['Closed', 'Pending Approval'],
  'Pending Approval': ['Closed', 'In Progress'],
  'Closed': [],
};

/** Maps finding status to recommendation status for sync */
export const FINDING_TO_RECOMMENDATION_STATUS: Record<string, string> = {
  'Open': 'Open',
  'In Progress': 'In Progress',
  'Closed': 'Implemented',
  'Pending Approval': 'In Progress',
};

export interface CreateFindingInput {
  audit_id: string;
  title: string;
  description?: string;
  criteria?: string;
  condition?: string;
  finding_type: FindingType;
  consequence?: string;
  risk_level: 'Low' | 'Medium' | 'High' | 'Critical';
}

export class AuditService {
  static async getFindings(params: any = {}) {
    const page = parseInt(params.page) || 1;
    const pageSize = parseInt(params.pageSize) || 20;
    const offset = (page - 1) * pageSize;

    let query = `SELECT af.*, u.name as created_by_name 
                 FROM audit_findings af
                 LEFT JOIN users u ON af.created_by = u.id`;
    let countQuery = "SELECT COUNT(*) as total FROM audit_findings af";
    const args: any[] = [];
    let whereClause = "";

    if (params.audit_id) {
      whereClause = " WHERE af.audit_id = ?";
      args.push(params.audit_id);
    }

    query += whereClause + " ORDER BY af.created_at DESC LIMIT ? OFFSET ?";
    countQuery += whereClause;

    const [data, countRes] = await Promise.all([
      db.prepare(query).all(...args, pageSize, offset),
      db.prepare(countQuery).get(...args)
    ]) as [any[], any];

    const total = countRes?.total || 0;

    return {
      data,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
      }
    };
  }

  /**
   * Returns findings for a specific plan.
   *
   * Validates:
   * - planId must reference an existing plan (throws NotFoundError otherwise)
   *
   * @param planId - The ID of the audit plan
   * @returns Array of findings belonging to the specified plan
   * @throws NotFoundError if plan does not exist
   */
  static async getFindingsByPlan(planId: string): Promise<any[]> {
    if (!planId) {
      throw new NotFoundError('الخطة غير موجودة / Audit plan not found');
    }

    // Validate plan exists
    const plan = await db.prepare(
      "SELECT id FROM audit_plans WHERE id = ?"
    ).get(planId) as any;

    if (!plan) {
      throw new NotFoundError('الخطة غير موجودة / Audit plan not found');
    }

    // Return findings for this plan only
    const findings = await db.prepare(
      "SELECT * FROM audit_findings WHERE audit_id = ? ORDER BY created_at DESC"
    ).all(planId) as any[];

    return findings;
  }

  /**
   * Creates a new audit finding with auto-generated recommendation.
   *
   * Validates:
   * - title: non-empty, max 200 chars
   * - finding_type: must be one of VALID_FINDING_TYPES
   * - audit_id: must reference an existing, non-archived plan
   *
   * Auto-generates:
   * - finding_number via NumberingService
   * - One recommendation with same risk_level, status 'Open', rec_number via NumberingService
   *
   * Sends:
   * - Notification to Manager/Admin users
   * - N8n automation event
   */
  static async createFinding(data: CreateFindingInput, userId: string): Promise<{ findingId: string; recommendationId: string }> {
    // Validate title
    const title = data.title?.trim();
    if (!title || title.length === 0) {
      throw new ValidationError('عنوان الملاحظة إلزامي ولا يمكن أن يكون فارغاً / Finding title is required and cannot be empty');
    }
    if (title.length > 200) {
      throw new ValidationError('عنوان الملاحظة يجب ألا يتجاوز 200 حرف / Finding title must not exceed 200 characters');
    }

    // Validate finding_type
    if (!data.finding_type || !VALID_FINDING_TYPES.includes(data.finding_type as FindingType)) {
      throw new ValidationError(
        'نوع الملاحظة غير مقبول. القيم المسموحة: control_design_deficiency, operational_design_deficiency / ' +
        'Invalid finding type. Allowed values: control_design_deficiency, operational_design_deficiency'
      );
    }

    // Validate audit_id
    if (!data.audit_id) {
      throw new ValidationError('معرّف الخطة (audit_id) مطلوب / audit_id is required');
    }

    return await db.transaction(async () => {
      // Fetch the plan (for plan_code and department)
      const plan = await db.prepare(
        "SELECT id, plan_code, department, is_archived FROM audit_plans WHERE id = ?"
      ).get(data.audit_id) as any;

      if (!plan) {
        throw new NotFoundError('الخطة غير موجودة / Audit plan not found');
      }

      if (plan.is_archived) {
        throw new ValidationError('لا يمكن إضافة ملاحظة لخطة مؤرشفة / Cannot add finding to an archived plan');
      }

      // Generate finding number via NumberingService
      const findingNumber = await NumberingService.nextFindingNumber(data.audit_id, plan.plan_code);

      // Insert the finding
      const findingResult = await db.prepare(`
        INSERT INTO audit_findings (
          audit_id, finding_number, title, description, criteria, condition,
          finding_type, consequence, risk_level, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?)
        RETURNING id
      `).get(
        data.audit_id,
        findingNumber,
        title,
        data.description || '',
        data.criteria || '',
        data.condition || '',
        data.finding_type,
        data.consequence || '',
        data.risk_level || 'Medium',
        userId
      ) as any;

      const findingId = findingResult?.id || findingResult?.lastInsertRowid;
      if (!findingId) {
        throw new Error('Failed to create finding');
      }

      // Generate recommendation number via NumberingService
      const recNumber = await NumberingService.nextRecommendationNumber(String(findingId), findingNumber);

      // Auto-create one recommendation with same risk_level
      const recResult = await db.prepare(`
        INSERT INTO recommendations (
          finding_id, plan_id, rec_number, department, responsible, due_date, status, risk_level
        ) VALUES (?, ?, ?, ?, 'TBD', '', 'Open', ?)
        RETURNING id
      `).get(
        findingId,
        data.audit_id,
        recNumber,
        plan.department || '',
        data.risk_level || 'Medium'
      ) as any;

      const recommendationId = recResult?.id || recResult?.lastInsertRowid;

      // Send notification to Manager/Admin
      try {
        const adminIds = await NotificationService.getAdminIds();
        const managerIds = await db.prepare(
          `SELECT id FROM users WHERE role = ? AND status = 'active'`
        ).all(UserRole.MANAGER) as any[];
        const managerUserIds = managerIds.map((m: any) => m.id);

        const allTargetIds = [...new Set([...adminIds, ...managerUserIds])];

        if (allTargetIds.length > 0) {
          await NotificationService.create(
            allTargetIds,
            'finding_added',
            JSON.stringify({ key: 'notifications.findingAdded', params: { title } }),
            'AuditFindings',
            '/audit-findings',
            { actorId: userId, entityId: String(findingId), entityType: 'audit_findings' }
          );
        }
      } catch (notifError) {
        // Notification failure should not block finding creation
        console.error('[AuditService] Notification failed:', (notifError as any)?.message);
      }

      // Send n8n automation event
      try {
        await N8nService.sendEvent('finding.created', {
          findingId: String(findingId),
          title,
          auditId: data.audit_id,
          riskLevel: data.risk_level,
          findingType: data.finding_type
        });
      } catch (n8nError) {
        // N8n failure should not block finding creation
        console.error('[AuditService] N8n event failed:', (n8nError as any)?.message);
      }

      return { findingId: String(findingId), recommendationId: String(recommendationId) };
    });
  }

  static async updateFinding(id: string, body: any, userId: string) {
    return await db.transaction(async () => {
      // Fetch the finding to check ownership
      const finding = await db.prepare(
        "SELECT id, created_by FROM audit_findings WHERE id = ?"
      ).get(id) as any;

      if (!finding) {
        throw new NotFoundError('الملاحظة غير موجودة / Finding not found');
      }

      // Ownership check: only the creator can edit
      if (finding.created_by !== userId) {
        throw new ForbiddenError(
          'ليس لديك صلاحية تعديل هذه الملاحظة. فقط كاتب الملاحظة يمكنه التعديل / ' +
          'You do not have permission to edit this finding. Only the finding creator can edit.'
        );
      }

      const data = { ...body };
      delete data.id;
      delete data.created_by; // Prevent overwriting ownership

      const keys = Object.keys(data).map(k => db.validateIdentifier(k));
      const values = Object.values(data);
      
      if (keys.length === 0) {
        throw new ValidationError("No data provided for update");
      }

      const setClause = keys.map(k => `${k} = ?`).join(",");
      await db.prepare(`UPDATE audit_findings SET ${setClause} WHERE id = ?`).run(...values, id);

      // Sync risk_level change to associated recommendation
      if (data.risk_level) {
        await db.prepare("UPDATE recommendations SET risk_level = ? WHERE finding_id = ?").run(data.risk_level, id);
      }

      // --- AUTOMATION: Send event to n8n ---
      await N8nService.sendEvent('finding.updated', {
        findingId: id,
        updates: data
      });
    });
  }

  static async deleteFinding(id: string) {
    return await db.transaction(async () => {
      await db.prepare("DELETE FROM recommendations WHERE finding_id = ?").run(id);
      await db.prepare("DELETE FROM audit_findings WHERE id = ?").run(id);

      // --- AUTOMATION: Send event to n8n ---
      await N8nService.sendEvent('finding.deleted', {
        findingId: id
      });
    });
  }

  /**
   * Changes the status of a finding with allowed transition enforcement and recommendation sync.
   *
   * Validates:
   * - Finding exists
   * - Transition is allowed per ALLOWED_FINDING_TRANSITIONS
   * - For Pending Approval→Closed: user must have APPROVE permission on AUDIT_FINDINGS
   *
   * Side effects:
   * - Syncs recommendation status via FINDING_TO_RECOMMENDATION_STATUS map (with retry up to 3 attempts)
   * - Sends notification to Manager/Admin on status change
   *
   * @param findingId - The ID of the finding to update
   * @param newStatus - The target status
   * @param userId - The ID of the user performing the action
   * @param userRole - The role of the user
   * @throws NotFoundError if finding does not exist
   * @throws ValidationError if transition is not allowed
   * @throws ForbiddenError if user lacks APPROVE permission for Pending Approval→Closed
   */
  static async changeFindingStatus(
    findingId: string,
    newStatus: string,
    userId: string,
    userRole: string
  ): Promise<{ syncSuccess: boolean }> {
    // 1. Validate finding exists
    const finding = await db.prepare(
      "SELECT * FROM audit_findings WHERE id = ?"
    ).get(findingId) as any;

    if (!finding) {
      throw new NotFoundError('الملاحظة غير موجودة / Finding not found');
    }

    // 2. Enforce allowed transitions
    const allowedTransitions = ALLOWED_FINDING_TRANSITIONS[finding.status];
    if (!allowedTransitions || !allowedTransitions.includes(newStatus)) {
      throw new ValidationError(
        `انتقال حالة غير صالح من "${finding.status}" إلى "${newStatus}" / ` +
        `Invalid status transition from "${finding.status}" to "${newStatus}"`
      );
    }

    // 3. For Pending Approval→Closed: require APPROVE permission
    if (finding.status === 'Pending Approval' && newStatus === 'Closed') {
      const rolePermissions = DEFAULT_PERMISSIONS[userRole as Role];
      const modulePermissions = rolePermissions?.[MODULES.AUDIT_FINDINGS] || [];

      if (!modulePermissions.includes(PERMISSIONS.APPROVE)) {
        throw new ForbiddenError(
          'ليس لديك صلاحية الاعتماد لإغلاق هذه الملاحظة / ' +
          'You do not have APPROVE permission to close this finding'
        );
      }
    }

    // 4. Update finding status
    await db.prepare(
      "UPDATE audit_findings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(newStatus, findingId);

    // 5. Sync recommendation status with retry logic (up to 3 attempts)
    const recStatus = FINDING_TO_RECOMMENDATION_STATUS[newStatus];
    let syncSuccess = true;

    if (recStatus) {
      const MAX_RETRIES = 3;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await db.prepare(
            "UPDATE recommendations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE finding_id = ?"
          ).run(recStatus, findingId);
          lastError = null;
          break;
        } catch (err) {
          lastError = err as Error;
          console.error(
            `[AuditService] Recommendation sync attempt ${attempt}/${MAX_RETRIES} failed:`,
            (err as Error)?.message
          );
        }
      }

      if (lastError) {
        syncSuccess = false;
        console.error(
          '[AuditService] All recommendation sync attempts failed. Finding status updated but recommendation remains at last consistent state.'
        );
      }
    }

    // 6. Send notification to Manager/Admin on status change
    try {
      const adminIds = await NotificationService.getAdminIds();
      const managerIds = await db.prepare(
        `SELECT id FROM users WHERE role = ? AND status = 'active'`
      ).all(UserRole.MANAGER) as any[];
      const managerUserIds = managerIds.map((m: any) => m.id);

      const allTargetIds = [...new Set([...adminIds, ...managerUserIds])];

      if (allTargetIds.length > 0) {
        await NotificationService.create(
          allTargetIds,
          'finding_status_changed',
          JSON.stringify({
            key: 'notifications.findingStatusChanged',
            params: { title: finding.title, oldStatus: finding.status, newStatus }
          }),
          'AuditFindings',
          '/audit-findings',
          { actorId: userId, entityId: String(findingId), entityType: 'audit_findings' }
        );
      }
    } catch (notifError) {
      // Notification failure should not block status change
      console.error('[AuditService] Status change notification failed:', (notifError as any)?.message);
    }

    return { syncSuccess };
  }
}
