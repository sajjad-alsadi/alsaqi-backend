import { db } from '../db/index';

/**
 * Audit event types for permission changes.
 */
export type PermissionAuditEventType =
  | 'role_permission_change'
  | 'user_override_change'
  | 'custom_role_created'
  | 'custom_role_deleted';

/**
 * Audit log entry structure.
 */
export interface PermissionAuditEntry {
  id: string;
  eventType: PermissionAuditEventType;
  actorUserId: string;
  targetRoleId: string | null;
  targetUserId: string | null;
  oldState: any;
  newState: any;
  timestamp: string;
}

/**
 * Query filters for retrieving audit logs.
 */
export interface AuditLogQueryParams {
  actorUserId?: string;
  targetRoleId?: string;
  targetUserId?: string;
  eventType?: PermissionAuditEventType;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

/**
 * PermissionAuditService - Append-only audit logging for permission changes.
 *
 * Logs:
 * - Role permission changes (Req 12.1)
 * - User override changes (Req 12.2)
 * - Custom role creation/deletion (Req 12.3)
 *
 * Provides paginated, filterable retrieval (Req 12.4).
 * Entries are append-only - no modify/delete via API (Req 12.5).
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */
export class PermissionAuditService {
  /**
   * Create an audit log entry for a permission change.
   * Throws on failure so the caller can roll back the permission change (Req 12.6).
   */
  static async logPermissionChange(params: {
    eventType: PermissionAuditEventType;
    actorUserId: string;
    targetRoleId?: string | null;
    targetUserId?: string | null;
    oldState: any;
    newState: any;
  }): Promise<void> {
    const { eventType, actorUserId, targetRoleId, targetUserId, oldState, newState } = params;
    const timestamp = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO permission_audit_logs (event_type, actor_user_id, target_role_id, target_user_id, old_state, new_state, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventType,
        actorUserId,
        targetRoleId || null,
        targetUserId || null,
        oldState !== null && oldState !== undefined ? JSON.stringify(oldState) : null,
        newState !== null && newState !== undefined ? JSON.stringify(newState) : null,
        timestamp
      );
  }

  /**
   * Query audit log entries with pagination and filtering.
   * Max 50 entries per page (Req 12.4).
   */
  static async getAuditLogs(params: AuditLogQueryParams): Promise<{
    entries: PermissionAuditEntry[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(50, Math.max(1, params.limit || 50));
    const offset = (page - 1) * limit;

    // Build WHERE clauses
    const conditions: string[] = [];
    const queryParams: any[] = [];

    if (params.actorUserId) {
      conditions.push('actor_user_id = ?');
      queryParams.push(params.actorUserId);
    }

    if (params.targetRoleId) {
      conditions.push('target_role_id = ?');
      queryParams.push(params.targetRoleId);
    }

    if (params.targetUserId) {
      conditions.push('target_user_id = ?');
      queryParams.push(params.targetUserId);
    }

    if (params.eventType) {
      conditions.push('event_type = ?');
      queryParams.push(params.eventType);
    }

    if (params.startDate) {
      conditions.push('timestamp >= ?');
      queryParams.push(params.startDate);
    }

    if (params.endDate) {
      conditions.push('timestamp <= ?');
      queryParams.push(params.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await db
      .prepare(`SELECT COUNT(*)::int AS total FROM permission_audit_logs ${whereClause}`)
      .get(...queryParams);

    const total = countResult?.total || 0;

    // Get paginated entries
    const entries = await db
      .prepare(
        `SELECT id, event_type, actor_user_id, target_role_id, target_user_id, old_state, new_state, timestamp
         FROM permission_audit_logs
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .all(...queryParams, limit, offset);

    const mappedEntries: PermissionAuditEntry[] = entries.map((entry: any) => ({
      id: entry.id,
      eventType: entry.event_type,
      actorUserId: entry.actor_user_id,
      targetRoleId: entry.target_role_id || null,
      targetUserId: entry.target_user_id || null,
      oldState: entry.old_state ? JSON.parse(entry.old_state) : null,
      newState: entry.new_state ? JSON.parse(entry.new_state) : null,
      timestamp: entry.timestamp,
    }));

    return {
      entries: mappedEntries,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
