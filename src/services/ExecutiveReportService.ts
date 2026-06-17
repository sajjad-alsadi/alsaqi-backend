import { db } from '../db/index';

export class ExecutiveReportService {
  static async getExecutiveSummary() {
    const [totalAudits, completedAudits, highRiskFindings, topRisks, findingsByDept] = await Promise.all([
      db.prepare("SELECT COUNT(*) as count FROM audit_plans WHERE deleted_at IS NULL").get() as Promise<any>,
      db.prepare("SELECT COUNT(*) as count FROM audit_plans WHERE status = 'Closed' AND deleted_at IS NULL").get() as Promise<any>,
      db.prepare("SELECT COUNT(*) as count FROM audit_findings WHERE risk_level IN ('High', 'Critical') AND status != 'Closed' AND deleted_at IS NULL").get() as Promise<any>,
      db.prepare("SELECT description, rating, owner FROM risk_register WHERE rating IN ('High', 'Critical') AND deleted_at IS NULL ORDER BY score DESC LIMIT 5").all(),
      db.prepare(`
        SELECT p.department, COUNT(f.id) as count 
        FROM audit_findings f 
        JOIN audit_plans p ON f.audit_id = p.id 
        WHERE f.deleted_at IS NULL
        GROUP BY p.department
      `).all(),
    ]);

    return {
      totalAudits: totalAudits.count,
      completedAudits: completedAudits.count,
      highRiskFindings: highRiskFindings.count,
      topRisks,
      findingsByDept
    };
  }
}
