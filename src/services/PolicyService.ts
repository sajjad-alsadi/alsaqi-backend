import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';

export class PolicyService {
  static async getAll() {
    return await db.prepare("SELECT id, title, department, version, upload_date, status FROM internal_policies ORDER BY upload_date DESC").all();
  }

  static async getById(id: string | number) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (typeof id === 'string' && uuidRegex.test(id)) {
      const record = await db.prepare("SELECT * FROM internal_policies WHERE id = ?").get(id);
      if (record) return record;
    }

    // Try system_policies if not a UUID or not found in internal_policies
    const systemPolicy = await db.prepare("SELECT * FROM system_policies WHERE policy_key = ?").get(id);
    if (systemPolicy) return systemPolicy;

    throw new NotFoundError("Policy not found");
  }

  static async getFile(id: string | number) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (typeof id === 'string' && uuidRegex.test(id)) {
      const record = await db.prepare("SELECT file_url FROM internal_policies WHERE id = ?").get(id);
      if (record) return record;
    }

    throw new NotFoundError("Policy file not found");
  }

  static async create(data: any, username: string) {
    const { title, department, version, file_url, status } = data;
    const stmt = db.prepare(`INSERT INTO internal_policies (title, department, version, upload_date, file_url, status) VALUES (?, ?, ?, ?, ?, ?)`);
    const info = await stmt.run(title, department, version, new Date().toISOString().split('T')[0], file_url, status || 'Active');
    
    await db.prepare("INSERT INTO audit_trail (user, action, module, details) VALUES (?::text, ?::text, ?::text, ?::text)")
      .run(username, 'Added Internal Policy', 'Governance', `Title: ${title}`);
      
    return { id: info.lastInsertRowid };
  }

  static async update(id: string | number, data: any, username: string) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (typeof id === 'string' && uuidRegex.test(id)) {
      const { title, department, version, file_url, status } = data;
      const stmt = db.prepare(`UPDATE internal_policies SET title = ?, department = ?, version = ?, file_url = ?, status = ? WHERE id = ?`);
      await stmt.run(title, department, version, file_url, status, id);
      
      await db.prepare("INSERT INTO audit_trail (user, action, module, details) VALUES (?::text, ?::text, ?::text, ?::text)")
        .run(username, 'Updated Internal Policy', 'Governance', `ID: ${id}`);
      return true;
    }

    // Handle system_policies update
    const { content } = data;
    if (content !== undefined) {
      const stmt = db.prepare(`UPDATE system_policies SET content = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE policy_key = ?`);
      await stmt.run(content, username, id);
      
      await db.prepare("INSERT INTO audit_trail (user, action, module, details) VALUES (?::text, ?::text, ?::text, ?::text)")
        .run(username, 'Updated System Policy', 'Governance', `Key: ${id}`);
      return true;
    }
      
    return false;
  }

  static async delete(id: string | number, username: string) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    if (typeof id === 'string' && uuidRegex.test(id)) {
      const stmt = db.prepare(`DELETE FROM internal_policies WHERE id = ?`);
      await stmt.run(id);
      
      await db.prepare("INSERT INTO audit_trail (user, action, module, details) VALUES (?::text, ?::text, ?::text, ?::text)")
        .run(username, 'Deleted Internal Policy', 'Governance', `ID: ${id}`);
      return true;
    }

    // Handle system_policies delete
    const stmt = db.prepare(`DELETE FROM system_policies WHERE policy_key = ?`);
    await stmt.run(id);
    
    await db.prepare("INSERT INTO audit_trail (user, action, module, details) VALUES (?::text, ?::text, ?::text, ?::text)")
      .run(username, 'Deleted System Policy', 'Governance', `Key: ${id}`);
      
    return true;
  }
}
