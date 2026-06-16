import { db } from '../db/index';
import { ValidationError, ConflictError } from '../utils/errors';

export class OrgService {
  static async getOrgEntities(limit = 1000) {
    // Bounded to prevent an unbounded read (finding 1.33 → 2.33). org_entities has
    // no soft-delete column (archival is via status='Archived'), so it is bounded
    // by a clamped LIMIT only.
    const safeLimit = Math.min(Math.max(parseInt(String(limit)) || 1000, 1), 2000);
    return await db.prepare(`
      SELECT e.*, p.name_ar as parent_name_ar, p.name_en as parent_name_en, u.name as manager_name_full
      FROM org_entities e
      LEFT JOIN org_entities p ON e.parent_id = p.id
      LEFT JOIN users u ON e.manager_id = u.id
      ORDER BY e.display_order, e.name_ar
      LIMIT ?
    `).all(safeLimit);
  }

  static async createOrgEntity(data: any) {
    const { 
      entity_code, name_ar, name_en, entity_type, parent_id, 
      manager_id, manager_name, level, status, description, 
      display_order, location, cost_center_code, notes 
    } = data;

    // Detect the unique-constraint conflict portably (defect 1.22 → 2.22). The old
    // code matched the SQLite-specific message "UNIQUE constraint failed: ...",
    // which Postgres/PGlite never emit (they raise SQLSTATE 23505 with different
    // text), so ConflictError never fired and a raw 500 leaked. Pre-check the
    // unique entity_code first (consistent with DepartmentService.create).
    const existing = await db.prepare(
      "SELECT id FROM org_entities WHERE entity_code = ?"
    ).get(entity_code) as any;
    if (existing) {
      throw new ConflictError("Entity code must be unique");
    }

    try {
      const result = await db.prepare(`
        INSERT INTO org_entities (
          entity_code, name_ar, name_en, entity_type, parent_id, 
          manager_id, manager_name, level, status, description, 
          display_order, location, cost_center_code, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
      `).get(
        entity_code, name_ar, name_en, entity_type, parent_id, 
        manager_id, manager_name, level || 1, status || 'Active', description, 
        display_order || 0, location, cost_center_code, notes
      ) as any;

      return result?.id;
    } catch (error: any) {
      // Defense in depth: a concurrent insert can still violate the unique
      // constraint between the pre-check and the insert. Detect that portably via
      // the SQLSTATE unique-violation code (23505) or a generic message match
      // rather than the SQLite-only text.
      const message = String(error?.message || error || '');
      if (error?.code === '23505' || /(unique|duplicate)/i.test(message)) {
        throw new ConflictError("Entity code must be unique");
      }
      throw error;
    }
  }

  static async updateOrgEntity(id: string, data: any) {
    const { 
      entity_code, name_ar, name_en, entity_type, parent_id, 
      manager_id, manager_name, level, status, description, 
      display_order, location, cost_center_code, notes 
    } = data;

    // Check for circular reference. Ids are UUIDs, so the old guard that compared
    // their parsed-integer forms compared NaN to NaN (always false) and never
    // triggered (defect 1.22 → 2.22). Compare the UUIDs directly instead.
    if (parent_id && String(parent_id) === String(id)) {
      throw new ValidationError("An entity cannot be its own parent");
    }

    await db.prepare(`
      UPDATE org_entities SET 
        entity_code = ?, name_ar = ?, name_en = ?, entity_type = ?, parent_id = ?, 
        manager_id = ?, manager_name = ?, level = ?, status = ?, description = ?, 
        display_order = ?, location = ?, cost_center_code = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      entity_code, name_ar, name_en, entity_type, parent_id, 
      manager_id, manager_name, level, status, description, 
      display_order, location, cost_center_code, notes, id
    );
  }

  static async deleteOrgEntity(id: string) {
    // Reconciled with DepartmentService.delete to use consistent soft-delete
    // semantics (defect 1.22 → 2.22): archiving sets status='Archived' instead of
    // hard-deleting the row, and the children guard ignores already-archived
    // sub-entities (matching DepartmentService).
    const children = await db.prepare(
      "SELECT COUNT(*) as count FROM org_entities WHERE parent_id = ? AND status != 'Archived'"
    ).get(id) as any;
    if (children.count > 0) {
      throw new ValidationError("Cannot delete entity with sub-entities. Move or delete children first.");
    }

    // Check if linked to users
    const users = await db.prepare("SELECT COUNT(*) as count FROM users WHERE org_entity_id = ? OR division_id = ? OR unit_id = ?").get(id, id, id) as any;
    if (users.count > 0) {
      throw new ValidationError("Cannot delete entity linked to users. Archive it instead.");
    }

    await db.prepare(
      "UPDATE org_entities SET status = 'Archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(id);
  }
}
