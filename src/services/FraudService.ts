import { db } from '../db/index';
import { ValidationError, NotFoundError, ConflictError } from '../utils/errors';
import { ADMIN_ROLES } from '../constants.js';
import { N8nService } from '../utils/n8nService';

export class FraudService {
  static async createRequest(userId: number | string, userName: string, reason: string) {
    const existing = await db.prepare("SELECT * FROM fraud_access_requests WHERE user_id = ? AND status = 'Pending'").get(userId);
    if (existing) {
      throw new ConflictError("You already have a pending request.");
    }

    const stmt = db.prepare("INSERT INTO fraud_access_requests (user_id, user_name, reason) VALUES (?::uuid, ?::text, ?::text)");
    const info = await stmt.run(userId, userName, reason);
    
    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('fraud_access_request.created', {
      requestId: info.lastInsertRowid,
      userId,
      userName,
      reason
    });

    return info.lastInsertRowid;
  }

  static async getRequests(user: any) {
    if (ADMIN_ROLES.includes(user.role)) {
      return await db.prepare("SELECT * FROM fraud_access_requests ORDER BY request_date DESC").all();
    } else {
      return await db.prepare("SELECT * FROM fraud_access_requests WHERE user_id = ? ORDER BY request_date DESC").all(user.id);
    }
  }

  static async getMyStatus(userId: number | string) {
    const approved = await db.prepare(`
      SELECT * FROM fraud_access_requests 
      WHERE user_id = ? 
      AND status = 'Approved' 
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `).get(userId);

    if (approved) {
      return { status: 'Approved', ...(approved as any) };
    }
    
    const latest = await db.prepare("SELECT * FROM fraud_access_requests WHERE user_id = ? ORDER BY request_date DESC LIMIT 1").get(userId);
    if (latest) {
      if ((latest as any).status === 'Approved') {
        return { status: 'None' };
      }
      return latest;
    }
    return { status: 'None' };
  }

  static async approveRequest(id: string, duration: number | string, responderId: number | string) {
    const request = await db.prepare("SELECT * FROM fraud_access_requests WHERE id = ?").get(id) as any;
    if (!request) throw new NotFoundError("Request not found");

    let expiresAt = null;
    if (duration) {
      const date = new Date();
      const durationNum = typeof duration === 'string' ? parseInt(duration, 10) : duration;
      date.setDate(date.getDate() + durationNum);
      expiresAt = date.toISOString();
    }

    await db.prepare("UPDATE fraud_access_requests SET status = 'Approved', response_date = CURRENT_TIMESTAMP, responded_by = ?::uuid, expires_at = ?::timestamp WHERE id = ?::uuid")
              .run(responderId, expiresAt, id);
    
    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('fraud_access_request.status_changed', {
      requestId: id,
      status: 'Approved',
      duration,
      responderId
    });

    return request;
  }

  static async rejectRequest(id: string, reason: string, responderId: number | string) {
    const request = await db.prepare("SELECT * FROM fraud_access_requests WHERE id = ?").get(id) as any;
    if (!request) throw new NotFoundError("Request not found");

    await db.prepare("UPDATE fraud_access_requests SET status = 'Rejected', rejection_reason = ?::text, response_date = CURRENT_TIMESTAMP, responded_by = ?::uuid WHERE id = ?::uuid")
              .run(reason, responderId, id);
    
    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('fraud_access_request.status_changed', {
      requestId: id,
      status: 'Rejected',
      reason,
      responderId
    });

    return request;
  }
}

