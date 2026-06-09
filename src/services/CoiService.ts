import { db } from '../db/index';
import { NotFoundError } from '../utils/errors';
import { N8nService } from '../utils/n8nService';

export class CoiService {
  static async getAll() {
    return await db.prepare("SELECT * FROM conflict_of_interest ORDER BY declaration_date DESC").all();
  }

  static async create(userId: string | number, username: string, data: any) {
    const { description, related_party } = data;
    const stmt = db.prepare(`INSERT INTO conflict_of_interest (user_id, user_name, declaration_date, description, related_party) VALUES (?, ?, ?, ?, ?)`);
    const info = await stmt.run(userId, username, new Date().toISOString().split('T')[0], description, related_party);
    
    await db.prepare("INSERT INTO audit_trail (user, action, module, details) VALUES (?::text, ?::text, ?::text, ?::text)")
      .run(username, 'Created Conflict of Interest Declaration', 'Governance', `ID: ${info.lastInsertRowid}`);
      
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
    
    await db.prepare("INSERT INTO audit_trail (user, action, module, details) VALUES (?::text, ?::text, ?::text, ?::text)")
      .run(username, 'Updated Conflict of Interest Status', 'Governance', `ID: ${id}`);
      
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

