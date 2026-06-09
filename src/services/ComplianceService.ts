import { db } from '../db/index';

export class ComplianceService {

  static async getAll(filters?: {
    source_type?: string;
    compliance_status?: string;
    search?: string;
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
      sql += ` AND (ci.title LIKE ? OR ci.ref_number LIKE ? OR ci.description LIKE ?)`;
      const term = `%${filters.search}%`;
      params.push(term, term, term);
    }

    sql += ` ORDER BY ci.created_at DESC`;
    // Wait, PGlite requires `db.prepare(sql).all(...params)` ? 
    // Yes, but let's check PGlite docs. PGlite `db.query(sql, params)`. 
    // Wait, the project uses `db.prepare().all()` - maybe it's not PGlite, or it's a wrapper.
    // The previous instructions show: return await db.prepare(sql).all(...params);
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
    if (!item) throw new Error('NOT_FOUND');
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
    await db.prepare(`
      UPDATE compliance_items SET
        title = COALESCE(?, title),
        source_type = COALESCE(?, source_type),
        issuing_authority = COALESCE(?, issuing_authority),
        category = COALESCE(?, category),
        issue_date = COALESCE(?, issue_date),
        effective_date = COALESCE(?, effective_date),
        review_date = COALESCE(?, review_date),
        compliance_status = COALESCE(?, compliance_status),
        maturity_score = COALESCE(?, maturity_score),
        gap_notes = COALESCE(?, gap_notes),
        responsible_person_id = COALESCE(?, responsible_person_id),
        department_id = COALESCE(?, department_id),
        description = COALESCE(?, description),
        keywords = COALESCE(?, keywords),
        version = COALESCE(?, version),
        attachment_path = COALESCE(?, attachment_path),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND deleted_at IS NULL
    `).run(
      data.title, data.source_type, data.issuing_authority,
      data.category, data.issue_date, data.effective_date,
      data.review_date, data.compliance_status, data.maturity_score,
      data.gap_notes, data.responsible_person_id, data.department_id,
      data.description, data.keywords, data.version, data.attachment_path, id
    );
  }

  static async softDelete(id: string) {
    await db.prepare(
      `UPDATE compliance_items SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(id);
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
