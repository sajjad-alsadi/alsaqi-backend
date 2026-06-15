import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';

export class ComplianceService {

  static async getAll(filters?: {
    source_type?: string;
    compliance_status?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    let sql = `
      SELECT
        ci.*,
        u.name  AS responsible_person_name,
        o.name_en       AS department_name,
        (SELECT COUNT(*) FROM finding_compliance fc WHERE fc.compliance_id = ci.id) AS open_findings_count
      FROM compliance_items ci
      LEFT JOIN users      u ON ci.responsible_person_id = u.id
      LEFT JOIN org_entities o ON ci.department_id = o.id
      WHERE ci.deleted_at IS NULL
    `;
    const params: any[] = [];

    if (filters?.source_type) {
      sql += ` AND ci.source_type = ?`;
      params.push(filters.source_type);
    }
    if (filters?.compliance_status) {
      sql += ` AND ci.compliance_status = ?`;
      params.push(filters.compliance_status);
    }
    if (filters?.search) {
      // Escape LIKE wildcards so a search term containing % or _ is matched
      // literally. Backslash must be escaped first, then % and _. The matching
      // LIKE clauses declare ESCAPE '\' (written as '\\' in this JS literal).
      const escaped = filters.search
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      sql += ` AND (ci.title LIKE ? ESCAPE '\\' OR ci.ref_number LIKE ? ESCAPE '\\' OR ci.description LIKE ? ESCAPE '\\')`;
      const term = `%${escaped}%`;
      params.push(term, term, term);
    }

    sql += ` ORDER BY ci.created_at DESC`;

    // Apply pagination only when the caller explicitly provides page/pageSize.
    // When neither is supplied, return the full unpaginated result set
    // (preserves the prior behavior relied on by direct service callers).
    if (filters?.page != null || filters?.pageSize != null) {
      const pageSize = Number(filters?.pageSize) > 0 ? Number(filters?.pageSize) : 20;
      const page = Number(filters?.page) > 0 ? Number(filters?.page) : 1;
      sql += ` LIMIT ? OFFSET ?`;
      params.push(pageSize, (page - 1) * pageSize);
    }

    return await db.prepare(sql).all(...params);
  }

  static async getById(id: string) {
    const item = await db.prepare(`
      SELECT ci.*,
        u.name AS responsible_person_name,
        o.name_en      AS department_name
      FROM compliance_items ci
      LEFT JOIN users       u ON ci.responsible_person_id = u.id
      LEFT JOIN org_entities o ON ci.department_id = o.id
      WHERE ci.id = ? AND ci.deleted_at IS NULL
    `).get(id);
    if (!item) throw new NotFoundError('Compliance item not found');
    return item;
  }

  static async create(data: any, createdBy: string) {
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO compliance_items
        (id, ref_number, title, source_type, issuing_authority, category,
         issue_date, effective_date, review_date, compliance_status,
         maturity_score, gap_notes, responsible_person_id, department_id,
         description, keywords, version, attachment_path, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, data.ref_number, data.title, data.source_type,
      data.issuing_authority ?? null, data.category ?? null,
      data.issue_date ?? null, data.effective_date ?? null,
      data.review_date ?? null, data.compliance_status ?? 'under_review',
      data.maturity_score ?? null, data.gap_notes ?? null,
      data.responsible_person_id ?? null, data.department_id ?? null,
      data.description ?? null, data.keywords ?? null,
      data.version ?? null, data.attachment_path ?? null, createdBy
    );
    return { id };
  }

  static async update(id: string, data: any) {
    // Build the SET clause dynamically from the fields actually provided.
    // Only columns present in `data` are updated; a provided value of `null`
    // intentionally nulls the (optional) column instead of being ignored as
    // the previous COALESCE(?, col) form did.
    const updatableFields = [
      'title', 'source_type', 'issuing_authority', 'category',
      'issue_date', 'effective_date', 'review_date', 'compliance_status',
      'maturity_score', 'gap_notes', 'responsible_person_id', 'department_id',
      'description', 'keywords', 'version', 'attachment_path',
    ];

    const setClauses: string[] = [];
    const params: any[] = [];
    for (const field of updatableFields) {
      if (field in data) {
        setClauses.push(`${field} = ?`);
        params.push(data[field]);
      }
    }

    // Nothing to update beyond the timestamp; still touch updated_at so the
    // call remains a well-formed (and observable) update.
    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);

    params.push(id);
    await db.prepare(`
      UPDATE compliance_items SET
        ${setClauses.join(',\n        ')}
      WHERE id = ? AND deleted_at IS NULL
    `).run(...params);
  }

  static async softDelete(id: string, deletedBy: string) {
    const result = await db.prepare(
      `UPDATE compliance_items
         SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
       WHERE id = ? AND deleted_at IS NULL`
    ).run(deletedBy ?? null, id);
    // No row affected → the item does not exist or was already deleted.
    if (result.changes === 0) {
      throw new NotFoundError('Compliance item not found or already deleted');
    }
  }

  static async getSummary() {
    const counts = await db.prepare(`
      SELECT
        compliance_status,
        COUNT(*) AS count
      FROM compliance_items
      WHERE deleted_at IS NULL
      GROUP BY compliance_status
    `).all() as any[];

    const overdueReview = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM compliance_items
      WHERE deleted_at IS NULL
        AND review_date IS NOT NULL
        AND review_date != ''
        AND CAST(review_date AS date) < CURRENT_DATE
    `).get() as any;

    const dueSoon = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM compliance_items
      WHERE deleted_at IS NULL
        AND review_date IS NOT NULL
        AND review_date != ''
        AND CAST(review_date AS date) BETWEEN CURRENT_DATE AND (CURRENT_DATE + interval '30 days')
    `).get() as any;

    return { counts, overdueReview: overdueReview?.count ?? 0, dueSoon: dueSoon?.count ?? 0 };
  }
}
