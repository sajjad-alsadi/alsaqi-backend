import { db } from '../db/index';

export class ExecutiveReportService {
  static async getExecutiveSummary() {
    const totalAudits = await db.prepare("SELECT COUNT(*) as count FROM audit_plans").get() as any;
    const completedAudits = await db.prepare("SELECT COUNT(*) as count FROM audit_plans WHERE status = 'Closed'").get() as any;
    const highRiskFindings = await db.prepare("SELECT COUNT(*) as count FROM audit_findings WHERE risk_level IN ('High', 'Critical') AND status != 'Closed'").get() as any;
    const topRisks = await db.prepare("SELECT description, rating, owner FROM risk_register WHERE rating IN ('High', 'Critical') ORDER BY score DESC LIMIT 5").all();
    const findingsByDept = await db.prepare(`
      SELECT p.department, COUNT(f.id) as count 
      FROM audit_findings f 
      JOIN audit_plans p ON f.audit_id = p.id 
      GROUP BY p.department
    `).all();

    return {
      totalAudits: totalAudits.count,
      completedAudits: completedAudits.count,
      highRiskFindings: highRiskFindings.count,
      topRisks,
      findingsByDept
    };
  }
}
