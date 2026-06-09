import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';

export class LogService {
  static async getLoginHistory(query: any) {
    const page = parseInt(query.page as string) || 1;
    const pageSize = parseInt(query.pageSize as string) || 50;
    const offset = (page - 1) * pageSize;

    const countRes = await db.prepare(`SELECT COUNT(*) as total FROM login_history`).get() as any;
    const total = countRes?.total || 0;

    const history = await db.prepare(`
      SELECT l.id, l.user_id, l.login_time, l.ip_address, l.user_agent, l.status, u.name as user_name
      FROM login_history l
      LEFT JOIN users u ON l.user_id = u.id
      ORDER BY l.login_time DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset);
    
    return {
      data: history,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    };
  }

  static async getAuditTrail(query: any) {
    const page = parseInt(query.page as string) || 1;
    const pageSize = parseInt(query.pageSize as string) || 50;
    const offset = (page - 1) * pageSize;
    const { module, action, username } = query;

    const conditions: string[] = [];
    const params: any[] = [];

    if (module) {
      conditions.push("LOWER(module) LIKE ?");
      params.push(`%${module.toLowerCase()}%`);
    }
    if (action) {
      conditions.push("LOWER(action) LIKE ?");
      params.push(`%${action.toLowerCase()}%`);
    }
    if (username) {
      conditions.push('"user" LIKE ?');
      params.push(`%${username}%`);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : "";

    const countRes = await db.prepare(`SELECT COUNT(*) as total FROM audit_trail${whereClause}`).get(...params) as any;
    const total = countRes?.total || 0;

    const logs = await db.prepare(`SELECT id, "user", action, module, details, timestamp FROM audit_trail${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);
    
    return {
      data: logs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    };
  }

  static async logSystemError(data: any) {
    const { message, stack, module, userId, severity, user_agent, url, request_data } = data;
    await db.prepare(`
      INSERT INTO system_error_log 
      (message, stack, module, user_id, severity, user_agent, url, request_data) 
      VALUES (?::text, ?::text, ?::text, ?::uuid, ?::text, ?::text, ?::text, ?::text)
    `).run(
      message, 
      stack ? stack.substring(0, 2000) : null, 
      module, 
      userId || null, 
      severity || 'error', 
      user_agent || null, 
      url || null, 
      request_data ? JSON.stringify(request_data) : null
    );
    return true;
  }

  static async getSystemErrors(query: any) {
    const page = parseInt(query.page as string) || 1;
    const pageSize = parseInt(query.pageSize as string) || 50;
    const offset = (page - 1) * pageSize;
    const { module, severity, start_date, end_date, user_id } = query;

    const conditions: string[] = [];
    const params: any[] = [];

    if (module) {
      conditions.push("module LIKE ?");
      params.push(`%${module}%`);
    }
    if (severity) {
      conditions.push("severity = ?");
      params.push(severity);
    }
    if (start_date) {
      conditions.push("timestamp >= ?");
      params.push(start_date);
    }
    if (end_date) {
      conditions.push("timestamp <= ?");
      params.push(end_date);
    }
    if (user_id) {
      conditions.push("user_id = ?");
      params.push(user_id);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : "";

    const countRes = await db.prepare(`SELECT COUNT(*) as total FROM system_error_log${whereClause}`).get(...params) as any;
    const total = countRes?.total || 0;

    const logs = await db.prepare(`SELECT id, message, module, user_id, severity, url, timestamp FROM system_error_log${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset) as any[];
    
    return {
      data: logs.map(log => ({ ...log, request_data: log.request_data ? JSON.parse(log.request_data) : null })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    };
  }

  static async clearSystemErrors() {
    await db.prepare("DELETE FROM system_error_log").run();
    return true;
  }

  static async getSystemErrorsForExport() {
    return await db.prepare("SELECT * FROM system_error_log ORDER BY timestamp DESC").all();
  }

  static async getSystemErrorAnalytics() {
    return await db.prepare(`
      SELECT severity, COUNT(*) as count, DATE(timestamp) as date
      FROM system_error_log
      GROUP BY severity, DATE(timestamp)
      ORDER BY date DESC
    `).all();
  }
}
