import { db } from '../db/index';
import { NotFoundError, ForbiddenError, ValidationError } from '../utils/errors';
import { UserRole } from '@alsaqi/shared';
import { NotificationService } from './NotificationService';
import { MODULES, PERMISSIONS } from '../permissions.js';
import { PermissionService } from './PermissionService';

export interface CreateProgramInput {
  program_code: string;
  program_title: string;
  audit_area: string;
  department: string;
  audit_type: string;
  audit_objective: string;
  audit_scope: string;
  key_risks?: string;
  reference_standard?: string;
  risk_ids?: string[];
  compliance_item_ids?: string[];
}

export class AuditProgramService {
  private static db = db;

  /**
   * Creates a new audit program with risk and compliance linking.
   * 
   * Restrictions:
   * - Only Internal Auditor role can create programs
   * - Sets initial status to 'Draft' and version_number to 1
   * - Validates risk_ids exist in risk_register (max 200, no duplicates)
   * - Validates compliance_item_ids exist in compliance_items (max 200, no duplicates)
   * - Creates links in program_risk_links and program_compliance_links
   * - Sends notification to Manager/Admin for approval
   * 
   * @param data - Program creation data including optional risk_ids and compliance_item_ids
   * @param userId - The ID of the user creating the program
   * @param userRole - The role of the user (must be 'Internal Auditor')
   * @throws ForbiddenError if user is not Internal Auditor
   * @throws ValidationError if risk_ids or compliance_item_ids are invalid
   */
  static async createProgram(
    data: CreateProgramInput,
    userId: string,
    userRole: string
  ): Promise<{ programId: string }> {
    // 1. Only Internal Auditor can create programs
    if (userRole !== UserRole.INTERNAL_AUDITOR) {
      throw new ForbiddenError('فقط المدقق الداخلي يمكنه إنشاء برامج التدقيق');
    }

    const riskIds = data.risk_ids || [];
    const complianceItemIds = data.compliance_item_ids || [];

    // 2. Validate max 200 risk_ids
    if (riskIds.length > 200) {
      throw new ValidationError('لا يمكن ربط أكثر من 200 مخاطرة بالبرنامج', {
        field: 'risk_ids',
        max: 200,
        provided: riskIds.length,
      });
    }

    // 3. Validate max 200 compliance_item_ids
    if (complianceItemIds.length > 200) {
      throw new ValidationError('لا يمكن ربط أكثر من 200 معيار امتثال بالبرنامج', {
        field: 'compliance_item_ids',
        max: 200,
        provided: complianceItemIds.length,
      });
    }

    // 4. Check for duplicate risk_ids
    const uniqueRiskIds = new Set(riskIds);
    if (uniqueRiskIds.size !== riskIds.length) {
      throw new ValidationError('قائمة معرّفات المخاطر تحتوي على قيم مكررة', {
        field: 'risk_ids',
        duplicates: riskIds.filter((id, idx) => riskIds.indexOf(id) !== idx),
      });
    }

    // 5. Check for duplicate compliance_item_ids
    const uniqueComplianceIds = new Set(complianceItemIds);
    if (uniqueComplianceIds.size !== complianceItemIds.length) {
      throw new ValidationError('قائمة معرّفات معايير الامتثال تحتوي على قيم مكررة', {
        field: 'compliance_item_ids',
        duplicates: complianceItemIds.filter((id, idx) => complianceItemIds.indexOf(id) !== idx),
      });
    }

    return await this.db.transaction(async () => {
      // 6. Validate risk_ids exist in risk_register
      if (riskIds.length > 0) {
        const placeholders = riskIds.map(() => '?').join(',');
        const existingRisks = await this.db.prepare(
          `SELECT id FROM risk_register WHERE id IN (${placeholders})`
        ).all(...riskIds) as any[];

        const existingRiskIds = new Set(existingRisks.map((r: any) => r.id));
        const missingRiskIds = riskIds.filter(id => !existingRiskIds.has(id));

        if (missingRiskIds.length > 0) {
          throw new ValidationError('بعض معرّفات المخاطر غير موجودة في سجل المخاطر', {
            field: 'risk_ids',
            missing: missingRiskIds,
          });
        }
      }

      // 7. Validate compliance_item_ids exist in compliance_items
      if (complianceItemIds.length > 0) {
        const placeholders = complianceItemIds.map(() => '?').join(',');
        const existingCompliance = await this.db.prepare(
          `SELECT id FROM compliance_items WHERE id IN (${placeholders})`
        ).all(...complianceItemIds) as any[];

        const existingComplianceIds = new Set(existingCompliance.map((c: any) => c.id));
        const missingComplianceIds = complianceItemIds.filter(id => !existingComplianceIds.has(id));

        if (missingComplianceIds.length > 0) {
          throw new ValidationError('بعض معرّفات معايير الامتثال غير موجودة في مصفوفة الامتثال', {
            field: 'compliance_item_ids',
            missing: missingComplianceIds,
          });
        }
      }

      // 8. Create the program with status 'Draft' and version_number 1
      const program = await this.db.prepare(`
        INSERT INTO audit_programs (
          program_code, program_title, audit_area, department,
          audit_type, audit_objective, audit_scope, key_risks,
          reference_standard, status, version_number, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', 1, ?)
        RETURNING id
      `).get(
        data.program_code, data.program_title, data.audit_area,
        data.department, data.audit_type, data.audit_objective,
        data.audit_scope, data.key_risks || '',
        data.reference_standard || '', userId
      ) as any;

      const programId = program.id;

      // 9. Create risk links
      for (const riskId of riskIds) {
        await this.db.prepare(
          "INSERT INTO program_risk_links (program_id, risk_id) VALUES (?, ?)"
        ).run(programId, riskId);
      }

      // 10. Create compliance links
      for (const complianceId of complianceItemIds) {
        await this.db.prepare(
          "INSERT INTO program_compliance_links (program_id, compliance_item_id) VALUES (?, ?)"
        ).run(programId, complianceId);
      }

      // 11. Send notification to Manager and Admin for approval
      const managerAndAdminIds = await this.db.prepare(
        `SELECT id FROM users WHERE role IN (?, ?) AND status = 'Active'`
      ).all(UserRole.MANAGER, UserRole.ADMIN) as any[];

      const recipientIds = managerAndAdminIds.map((u: any) => u.id);

      if (recipientIds.length > 0) {
        await NotificationService.create(
          recipientIds,
          'record_created',
          JSON.stringify({ key: 'notifications.programPendingApproval', params: { title: data.program_title } }),
          'AuditProgramLibrary',
          '/library',
          { actorId: userId, entityId: programId, entityType: 'audit_program' }
        );
      }

      return { programId };
    });
  }

  static async duplicate(id: string | number, username: string) {
    return await this.db.transaction(async () => {
      const program = await this.db.prepare("SELECT * FROM audit_programs WHERE id = ?").get(id) as any;
      if (!program) throw new NotFoundError("Program not found");
      
      const { id: oldId, created_at, updated_at, ...programData } = program;
      programData.program_title = `${programData.program_title} (Copy)`;
      programData.program_code = `${programData.program_code}-COPY`;
      programData.status = 'Draft';
      programData.created_by = username;
      programData.version_number = 1;
      
      const keys = Object.keys(programData).map(k => this.db.validateIdentifier(k));
      const values = Object.values(programData);
      const placeholders = keys.map(() => "?").join(",");
      const stmt = this.db.prepare(`INSERT INTO audit_programs (${keys.join(",")}) VALUES (${placeholders}) RETURNING id`);
      const res = await stmt.get(...values);
      const newId = res.id;
      
      // Duplicate procedures using a single efficient INSERT INTO ... SELECT query (Replacing N+1 Query)
      await this.db.prepare(`
        INSERT INTO audit_procedures (
          program_id, procedure_number, audit_step, audit_test_description, 
          risk_addressed, control_test_type, expected_evidence, 
          sampling_method, responsible_auditor, remarks
        )
        SELECT 
          ?, procedure_number, audit_step, audit_test_description, 
          risk_addressed, control_test_type, expected_evidence, 
          sampling_method, responsible_auditor, remarks
        FROM audit_procedures WHERE program_id = ?
      `).run(newId, id);
      
      return newId;
    });
  }

  /**
   * Approves an audit program after validating permissions and status.
   * 
   * Restrictions:
   * - User must have APPROVE permission on AUDIT_PROGRAM_LIBRARY module
   *   (Manager and Admin roles per the permission matrix)
   * - Program must exist
   * - Program status must be 'Draft' or 'Submitted'
   * - Sets status to 'Approved', records approved_by and approved_at
   * 
   * @param programId - The ID of the program to approve
   * @param userId - The ID of the user performing the approval
   * @param userRole - The role of the user
   * @throws ForbiddenError if user lacks APPROVE permission on AUDIT_PROGRAM_LIBRARY
   * @throws NotFoundError if program doesn't exist
   * @throws ValidationError if program status is not 'Draft' or 'Submitted'
   */
  static async approveProgram(
    programId: string,
    userId: string,
    userRole: string
  ): Promise<void> {
    // 1. Validate user has APPROVE permission on AUDIT_PROGRAM_LIBRARY.
    // Authorize against the user's EFFECTIVE DB permissions (role grants + user
    // overrides, with explicit denies subtracted) via PermissionService rather than the
    // static DEFAULT_PERMISSIONS map, so runtime permission changes and per-user
    // overrides are honored (finding 1.40 authz).
    const effective = await PermissionService.getUserPermissions(userId);
    const modulePermissions = effective.permissions[MODULES.AUDIT_PROGRAM_LIBRARY] || [];

    if (!modulePermissions.includes(PERMISSIONS.APPROVE)) {
      throw new ForbiddenError('ليس لديك صلاحية اعتماد برامج التدقيق');
    }

    // 2. Validate program exists
    const program = await this.db.prepare(
      "SELECT id, status FROM audit_programs WHERE id = ?"
    ).get(programId) as any;

    if (!program) {
      throw new NotFoundError('برنامج التدقيق غير موجود');
    }

    // 3. Validate program status is 'Draft' or 'Submitted'
    const approvableStatuses = ['Draft', 'Submitted'];
    if (!approvableStatuses.includes(program.status)) {
      throw new ValidationError(
        'لا يمكن اعتماد البرنامج إلا إذا كانت حالته "مسودة" أو "مُقدَّم"',
        { currentStatus: program.status, allowedStatuses: approvableStatuses }
      );
    }

    // 4. Set status to 'Approved', record approved_by and approved_at
    await this.db.prepare(
      "UPDATE audit_programs SET status = 'Approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(userId, programId);
  }
}
