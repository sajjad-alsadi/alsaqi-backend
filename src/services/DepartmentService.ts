// src/server/services/DepartmentService.ts
import { db } from '../db/index';
import { NotFoundError, ValidationError } from '../utils/errors';
import * as crypto from 'crypto';
import { AuditChainService } from './AuditChainService';

/**
 * DepartmentService — thin alias over org_entities.
 * All write operations go to org_entities.
 * getAll() returns a shape compatible with both legacy consumers
 * (that expect { id, name }) and new consumers (that use name_ar/name_en).
 */
export class DepartmentService {

  /** Returns org_entities in a shape that satisfies all existing dropdowns */
  static async getAll() {
    try {
      // Bounded to prevent an unbounded read (finding 1.33 → 2.33). org_entities
      // has no soft-delete column; archived rows are already excluded via
      // status != 'Archived'. The high LIMIT comfortably covers realistic org
      // structures while capping worst-case result size.
      return await db.prepare(`
        SELECT
          id,
          name_ar        AS name,          -- legacy consumers use .name
          name_ar,
          name_en,
          entity_code    AS code,
          entity_type,
          parent_id,
          manager_id,
          manager_name,
          level,
          status,
          display_order
        FROM org_entities
        WHERE status != 'Archived'
        ORDER BY level, display_order, name_ar
        LIMIT 2000
      `).all();
    } catch (error) {
      console.error("Error in DepartmentService.getAll:", error);
      return [];
    }
  }

  /** Returns only root-level entities and their children as a nested tree */
  static async getTree() {
    const all = await DepartmentService.getAll() as any[];
    return DepartmentService.buildTree(all, null);
  }

  private static buildTree(nodes: any[], parentId: string | null): any[] {
    return nodes
      .filter(n => (n.parent_id ?? null) === parentId)
      .map(n => ({ ...n, children: DepartmentService.buildTree(nodes, n.id) }));
  }

  static async create(data: {
    entity_code: string;
    name_ar: string;
    name_en?: string;
    entity_type?: string;
    parent_id?: string | null;
    manager_name?: string;
    description?: string;
    location?: string;
    cost_center_code?: string;
  }, createdBy: string) {
    const existing = await db.prepare(
      `SELECT id FROM org_entities WHERE entity_code = ?`
    ).get(data.entity_code) as any;
    if (existing) throw new ValidationError('Entity code already exists');

    const id = crypto.randomUUID();
    const parent = data.parent_id
      ? await db.prepare(`SELECT level FROM org_entities WHERE id = ?`).get(data.parent_id) as any
      : null;
    const level = parent ? parent.level + 1 : 1;

    await db.prepare(`
      INSERT INTO org_entities
        (id, entity_code, name_ar, name_en, entity_type, parent_id,
         manager_name, level, status, description, location, cost_center_code,
         created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'Active',?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `).run(
      id, data.entity_code, data.name_ar, data.name_en || data.name_ar,
      data.entity_type ?? 'Department', data.parent_id ?? null,
      data.manager_name ?? null, level,
      data.description ?? null, data.location ?? null,
      data.cost_center_code ?? null
    );

    await AuditChainService.append({
      user: createdBy,
      action: 'Created Org Entity',
      module: 'OrgStructure',
      details: `Created: ${data.name_ar} (${data.entity_code})`,
    });

    return { id, name: data.name_ar };
  }

  static async update(id: string, data: Partial<{
    name_ar: string; name_en: string; entity_type: string;
    parent_id: string | null; manager_name: string;
    description: string; location: string;
    cost_center_code: string; status: string;
  }>, updatedBy: string) {
    const existing = await db.prepare(
      `SELECT name_ar FROM org_entities WHERE id = ?`
    ).get(id) as any;
    if (!existing) throw new NotFoundError('Org entity not found');

    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    // Validate every column identifier before interpolating it into the dynamic
    // SET clause, matching every other dynamic-SET path (finding 1.12 → 2.12).
    const sets = entries.map(([k]) => `${db.validateIdentifier(k)} = ?`).join(', ');
    const vals = entries.map(([, v]) => v);

    if (sets) {
      await db.prepare(
        `UPDATE org_entities SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(...vals, id);
    }

    await AuditChainService.append({
      user: updatedBy,
      action: 'Updated Org Entity',
      module: 'OrgStructure',
      details: `Updated entity ID: ${id}`,
    });

    return { id };
  }

  /** Soft-delete: set status = Archived. Hard delete if no children and no references. */
  static async delete(id: string, deletedBy: string) {
    const children = await db.prepare(
      `SELECT COUNT(*) AS count FROM org_entities WHERE parent_id = ? AND status != 'Archived'`
    ).get(id) as any;
    if (children.count > 0) {
      throw new ValidationError(
        'Cannot delete an entity that has sub-units. Move or delete them first.'
      );
    }

    await db.prepare(
      `UPDATE org_entities SET status = 'Archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(id);

    await AuditChainService.append({
      user: deletedBy,
      action: 'Archived Org Entity',
      module: 'OrgStructure',
      details: `Archived entity ID: ${id}`,
    });
  }
}
