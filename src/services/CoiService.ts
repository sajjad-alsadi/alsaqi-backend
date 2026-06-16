import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';
import { N8nService } from '../utils/n8nService';
import { AuditChainService } from './AuditChainService';

export class CoiService {
  static async getAll(limit = 200) {
    // Bounded to prevent an unbounded read (finding 1.33 → 2.33). The
    // conflict_of_interest table has no soft-delete column, so it is bounded by a
    // clamped LIMIT only (no deleted_at filter).
    const safeLimit = Math.min(Math.max(parseInt(String(limit)) || 200, 1), 500);
    return await db
      .prepare("SELECT * FROM conflict_of_interest ORDER BY declaration_date DESC LIMIT ?")
      .all(safeLimit);
  }

  static async create(userId: string | number, username: string, data: any) {
    const { description, related_party } = data;
    const stmt = db.prepare(`INSERT INTO conflict_of_interest (user_id, user_name, declaration_date, description, related_party) VALUES (?, ?, ?, ?, ?)`);
    const info = await stmt.run(userId, username, new Date().toISOString().split('T')[0], description, related_party);
    
    await AuditChainService.append({
      user: username,
      action: 'Created Conflict of Interest Declaration',
      module: 'Governance',
      details: `ID: ${info.lastInsertRowid}`,
    });
      
    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('coi.created', {
      id: info.lastInsertRowid,
      userId,
      username,
      description,
      relatedParty: related_party
    });

    return { id: info.lastInsertRowid };
  }

  static async updateStatus(id: string | number, data: any, username: string) {
    const { status, reviewer_notes } = data;
    const stmt = db.prepare(`UPDATE conflict_of_interest SET status = ?, reviewer_notes = ? WHERE id = ?`);
    await stmt.run(status, reviewer_notes, id);
    
    await AuditChainService.append({
      user: username,
      action: 'Updated Conflict of Interest Status',
      module: 'Governance',
      details: `ID: ${id}`,
    });
      
    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('coi.status_changed', {
      id,
      status,
      reviewerNotes: reviewer_notes,
      updatedBy: username
    });

    return true;
  }
}

