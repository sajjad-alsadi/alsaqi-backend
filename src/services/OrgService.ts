import { db } from '../db/index';
import { ValidationError, ConflictError } from '../utils/errors';

export class OrgService {
  static async getOrgEntities() {
    return await db.prepare(`
      SELECT e.*, p.name_ar as parent_name_ar, p.name_en as parent_name_en, u.name as manager_name_full
      FROM org_entities e
      LEFT JOIN org_entities p ON e.parent_id = p.id
      LEFT JOIN users u ON e.manager_id = u.id
      ORDER BY e.display_order, e.name_ar
    `).all();
  }

  static async createOrgEntity(data: any) {
    const { 
      entity_code, name_ar, name_en, entity_type, parent_id, 
      manager_id, manager_name, level, status, description, 
      display_order, location, cost_center_code, notes 
    } = data;

    try {
      const result = await db.prepare(`
        INSERT INTO org_entities (
          entity_code, name_ar, name_en, entity_type, parent_id, 
          manager_id, manager_name, level, status, description, 
          display_order, location, cost_center_code, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entity_code, name_ar, name_en, entity_type, parent_id, 
        manager_id, manager_name, level || 1, status || 'Active', description, 
        display_order || 0, location, cost_center_code, notes
      );

      return result.lastInsertRowid;
    } catch (error: any) {
      if (error.message.includes("UNIQUE constraint failed: org_entities.entity_code")) {
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

    // Check for circular reference
    if (parent_id && parseInt(parent_id) === parseInt(id)) {
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
    // Check if has children
    const children = await db.prepare("SELECT COUNT(*) as count FROM org_entities WHERE parent_id = ?").get(id) as any;
    if (children.count > 0) {
      throw new ValidationError("Cannot delete entity with sub-entities. Move or delete children first.");
    }

    // Check if linked to users
    const users = await db.prepare("SELECT COUNT(*) as count FROM users WHERE org_entity_id = ? OR division_id = ? OR unit_id = ?").get(id, id, id) as any;
    if (users.count > 0) {
      throw new ValidationError("Cannot delete entity linked to users. Archive it instead.");
    }

    await db.prepare("DELETE FROM org_entities WHERE id = ?").run(id);
  }
}
