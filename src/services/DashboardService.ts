import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';
import { QueryBuilder } from '../utils/QueryBuilder';
import { computePaginationMeta } from '../utils/paginationService';

export class DashboardService {
  private static db = db;

  static async getDashboardStats(filters: { department?: string; riskLevel?: string } = {}) {
    const { department, riskLevel } = filters;
    const isFiltered = !!(department && department !== 'all');
    
    // Map lowercase filter to database values
    const deptMap: Record<string, string> = {
      'operational': 'Operational',
      'financial': 'Financial',
      'it': 'IT',
      'compliance': 'Compliance'
    };
    const mappedDept = isFiltered ? (deptMap[department!.toLowerCase()] || department) : null;

    // Plans Builder
    const auditQb = new QueryBuilder("FROM audit_plans")
      .where("deleted_at IS NULL")
      .whereIf(isFiltered, "type = ?", mappedDept);
    
    // Findings Builder
    const findingsBase = isFiltered ? "FROM audit_findings f JOIN audit_plans p ON f.audit_id = p.id" : "FROM audit_findings f";
    const findingsQb = new QueryBuilder(findingsBase)
      .where("f.deleted_at IS NULL")
      .whereIf(isFiltered, "p.type = ?", mappedDept)
      .whereIf(!!riskLevel, "f.risk_level = ?", riskLevel);
      
    // Recommendations Builder
    const recBase = isFiltered ? "FROM recommendations r JOIN audit_findings f ON r.finding_id = f.id JOIN audit_plans p ON f.audit_id = p.id" : "FROM recommendations r";
    const recQb = new QueryBuilder(recBase)
      .where("r.deleted_at IS NULL")
      .whereIf(isFiltered, "p.type = ?", mappedDept)
      .whereIf(!!riskLevel, "r.risk_level = ?", riskLevel);
      
    // Risk Builder
    const riskQb = new QueryBuilder("FROM risk_register")
      .where("deleted_at IS NULL")
      .whereIf(isFiltered, "type = ?", mappedDept);

    // Compliance Builder
    const complianceQb = new QueryBuilder("FROM central_bank_instructions")
      .where("status = 'Active'")
      .whereIf(isFiltered, "category = ?", mappedDept);

    // Execute unified query to minimize mutex locking overhead
    const bigQuery = `
      SELECT
        (SELECT json_build_object(
          'total', COUNT(*),
          'completed', COALESCE(SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END), 0),
          'in_progress', COALESCE(SUM(CASE WHEN status IN ('Fieldwork', 'Reporting') THEN 1 ELSE 0 END), 0),
          'delayed', COALESCE(SUM(CASE WHEN status != 'Closed' AND planned_end_date < TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') THEN 1 ELSE 0 END), 0)
        ) ${auditQb.buildCountQuery()}) as audit_stats,
        
        (SELECT json_build_object(
          'total', COUNT(*),
          'open_count', COALESCE(SUM(CASE WHEN f.status != 'Closed' THEN 1 ELSE 0 END), 0),
          'high_risk_open', COALESCE(SUM(CASE WHEN f.risk_level IN ('High', 'Critical') AND f.status != 'Closed' THEN 1 ELSE 0 END), 0)
        ) ${findingsQb.buildCountQuery()}) as findings_stats,

        (SELECT json_agg(t) FROM (
          SELECT f.risk_level as level, COUNT(*) as count ${findingsQb.buildCountQuery()} GROUP BY f.risk_level
        ) t) as findings_by_risk,

        (SELECT json_build_object(
          'total', COUNT(*),
          'pending_count', COALESCE(SUM(CASE WHEN r.status != 'Implemented' THEN 1 ELSE 0 END), 0),
          'overdue_count', COALESCE(SUM(CASE WHEN r.status != 'Implemented' AND r.due_date < TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') THEN 1 ELSE 0 END), 0)
        ) ${recQb.buildCountQuery()}) as rec_stats,

        (SELECT json_build_object(
          'total', COUNT(*),
          'high_count', COALESCE(SUM(CASE WHEN rating IN ('High', 'Critical') THEN 1 ELSE 0 END), 0)
        ) ${riskQb.buildCountQuery()}) as risk_stats,

        (SELECT json_agg(t) FROM (
          SELECT rating as level, COUNT(*) as count ${riskQb.buildCountQuery()} GROUP BY rating
        ) t) as risks_by_level,

        (SELECT json_build_object(
          'incoming_total', (SELECT COUNT(*) FROM incoming_correspondence WHERE deleted_at IS NULL),
          'outgoing_total', (SELECT COUNT(*) FROM outgoing_letters WHERE deleted_at IS NULL),
          'pending_responses', (SELECT COUNT(*) FROM incoming_correspondence WHERE response_required = 1 AND status != 'Closed' AND deleted_at IS NULL)
        )) as corr_stats,

        (SELECT COUNT(*) ${complianceQb.buildCountQuery()}) as compliance_count,

        (SELECT json_agg(t) FROM (
          SELECT id, "user", action, module, timestamp, details FROM audit_trail ORDER BY timestamp DESC LIMIT 10
        ) t) as recent_activity,

        (SELECT json_agg(t) FROM (
          SELECT 
            type,
            COUNT(*) as planned,
            COALESCE(SUM(CASE WHEN status = 'Closed' THEN 1 ELSE 0 END), 0) as completed
          FROM audit_plans
          WHERE deleted_at IS NULL
          GROUP BY type
        ) t) as audit_progress
    `;

    const allParams = [
      ...auditQb.buildParams(),
      ...findingsQb.buildParams(),
      ...findingsQb.buildParams(),
      ...recQb.buildParams(),
      ...riskQb.buildParams(),
      ...riskQb.buildParams(),
      ...complianceQb.buildParams()
    ];

    const data = await this.db.prepare(bigQuery).get(...allParams);

    return {
      audits: {
        total: Number(data?.audit_stats?.total || 0),
        completed: Number(data?.audit_stats?.completed || 0),
        in_progress: Number(data?.audit_stats?.in_progress || 0),
        delayed: Number(data?.audit_stats?.delayed || 0),
        progress_by_type: data?.audit_progress || []
      },
      findings: {
        summary: {
          total: Number(data?.findings_stats?.total || 0),
          open: Number(data?.findings_stats?.open_count || 0),
          high_risk_open: Number(data?.findings_stats?.high_risk_open || 0)
        },
        byRisk: data?.findings_by_risk || []
      },
      recommendations: {
        total: Number(data?.rec_stats?.total || 0),
        open: Number(data?.rec_stats?.pending_count || 0),
        overdue: Number(data?.rec_stats?.overdue_count || 0)
      },
      risks: {
        summary: {
          total: Number(data?.risk_stats?.total || 0),
          high: Number(data?.risk_stats?.high_count || 0)
        },
        byLevel: data?.risks_by_level || []
      },
      correspondence: {
        incoming_total: Number(data?.corr_stats?.incoming_total || 0),
        outgoing_total: Number(data?.corr_stats?.outgoing_total || 0),
        pending_responses: Number(data?.corr_stats?.pending_responses || 0)
      },
      compliance: {
        total: Number(data?.compliance_count || 0)
      },
      activity: data?.recent_activity || []
    };
  }

  static async getMyTasks(userId: string | number, page = 1, pageSize = 10) {
    const offset = (page - 1) * pageSize;
    const query = `
      SELECT t.id, t.title, t.task_number, t.status, t.due_date,
             p.title as plan_title
      FROM audit_tasks t
      LEFT JOIN audit_plans p ON t.plan_id = p.id
      WHERE t.assigned_to = ? AND t.deleted_at IS NULL
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;
    
    const countQuery = "SELECT COUNT(*) as total FROM audit_tasks WHERE assigned_to = ? AND deleted_at IS NULL";

    const [data, countRes] = await Promise.all([
      this.db.prepare(query).all(userId, pageSize, offset),
      this.db.prepare(countQuery).get(userId)
    ]) as [any[], any];

    const total = countRes?.total || 0;

    return {
      data,
      pagination: computePaginationMeta(page, pageSize, total)
    };
  }
}
