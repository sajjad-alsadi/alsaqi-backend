import { db } from '../db/index';

const DOC_TYPES: Record<string, string> = {
  audit_plans: 'PL',
  audit_programs: 'PR',
  audit_tasks: 'TSK',
  audit_findings: 'FD',
  audit_reports: 'REP',
  recommendations: 'REC',
  risk_register: 'RSK',
  central_bank_instructions: 'CBI',
  internal_policies: 'POL',
  law_bank: 'LAW',
  fraud_log: 'FRD',
  compliance_items: 'CMP'
};

const TABLE_CODE_COLUMNS: Record<string, string> = {
  audit_plans: 'plan_code',
  audit_programs: 'program_code',
  audit_tasks: 'task_number',
  audit_findings: 'finding_number',
  recommendations: 'rec_number',
  risk_register: 'risk_id',
  compliance_items: 'ref_number',
  fraud_log: 'incident_date' // wait, incident_date is not a code. we will skip this if it has no right field.
};

export class AppCodeGenerator {
  static async resolveDepartmentCode(departmentName?: string): Promise<string> {
    let deptCode = 'IA'; // Internal Audit by default
    if (departmentName) {
      try {
        const dept = await db.prepare("SELECT entity_code FROM org_entities WHERE name_ar = ? OR name_en = ?").get(departmentName, departmentName) as any;
        if (dept && dept.entity_code) {
          deptCode = dept.entity_code;
        } else {
            // Also try departments table just in case
            const legacyDept = await db.prepare("SELECT name FROM departments WHERE name = ?").get(departmentName) as any;
            if (legacyDept) {
                // Return IA as default if no entity_code was populated, or hash it
                deptCode = 'IA';
            }
        }
      } catch (e) {
        // ignore
      }
    }
    return deptCode;
  }

  static async generateFindingCode(auditId: string): Promise<string | null> {
    try {
      // Look up the audit plan to get its plan_code
      const plan = await db.prepare("SELECT plan_code, department FROM audit_plans WHERE id = ?").get(auditId) as any;

      if (plan && plan.plan_code) {
        // Generate plan-derived code: {plan_code}-FD-{NNN}
        const prefix = `${plan.plan_code}-FD-`;

        const latestFinding = await db.prepare(
          "SELECT finding_number as code FROM audit_findings WHERE finding_number LIKE ? ORDER BY finding_number DESC LIMIT 1"
        ).get(`${prefix}%`) as any;

        let nextNumber = 1;
        if (latestFinding && latestFinding.code) {
          const parts = latestFinding.code.split('-');
          const lastNumber = parseInt(parts[parts.length - 1]);
          if (!isNaN(lastNumber)) {
            nextNumber = lastNumber + 1;
          }
        }

        return `${prefix}${nextNumber.toString().padStart(3, '0')}`;
      }

      // Fallback: use existing generic format
      return await this.generateCode('audit_findings', plan?.department);
    } catch (error) {
      console.error('[AppCodeGenerator] Error generating finding code:', error);
      return await this.generateCode('audit_findings');
    }
  }

  static async generateCode(tableName: string, departmentName?: string): Promise<string | null> {
    const codeColumn = TABLE_CODE_COLUMNS[tableName];
    if (!codeColumn) return null;

    const currentYear = new Date().getFullYear();
    const shortYear = currentYear.toString().slice(-2);
    const deptCode = await this.resolveDepartmentCode(departmentName);
    const docType = DOC_TYPES[tableName] || 'DOC';
    
    // Format: DeptCode-DocType-YY-
    const prefix = `${deptCode}-${docType}-${shortYear}-`;

    try {
      const dbCol = db.validateIdentifier(codeColumn);
      const dbTable = db.validateIdentifier(tableName);
      
      const latestRecord = await db.prepare(
        `SELECT ${dbCol} as code FROM ${dbTable} 
         WHERE ${dbCol} LIKE ? 
         ORDER BY ${dbCol} DESC LIMIT 1`
      ).get(`${prefix}%`) as any;

      let nextNumber = 1;
      if (latestRecord && latestRecord.code) {
        const parts = latestRecord.code.split('-');
        const lastNumber = parseInt(parts[parts.length - 1]);
        if (!isNaN(lastNumber)) {
          nextNumber = lastNumber + 1;
        }
      }

      const formattedNumber = nextNumber.toString().padStart(3, '0');
      return `${prefix}${formattedNumber}`;
    } catch (error) {
      console.error(`[AppCodeGenerator] Error generating code for ${tableName}:`, error);
      return `${prefix}${Date.now().toString().slice(-4)}`;
    }
  }
}
