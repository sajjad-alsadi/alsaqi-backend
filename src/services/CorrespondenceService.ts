import { db } from '../db/index';
import { NotFoundError, ValidationError } from '../utils/errors';
import { QueryBuilder } from '../utils/QueryBuilder';
import { N8nService } from '../utils/n8nService';
import { NumberingService } from './NumberingService';
import { computePaginationMeta } from '../utils/paginationService';
import logger from '../utils/logger';

export class CorrespondenceService {
  private static db = db;

  static async getIncoming(filters: any) {
    const { archived, search, status, priority, dept_id, start_date, end_date, page = 1, pageSize = 10 } = filters;
    const isArchived = archived === 'true' ? 1 : 0;
    
    const baseQueryString = `
      FROM incoming_correspondence i
      LEFT JOIN org_entities d ON i.assigned_dept_id = d.id
      LEFT JOIN users u ON i.assigned_user_id = u.id
    `;
    
    const qb = new QueryBuilder(baseQueryString)
      .where('i.deleted_at IS NULL')
      .where('i.is_archived = ?', isArchived)
      .whereIf(!!status, 'i.status = ?', status)
      .whereIf(!!priority, 'i.priority = ?', priority)
      .whereIf(!!dept_id, 'i.assigned_dept_id = ?', dept_id)
      .whereIf(!!start_date, 'i.letter_date >= ?', start_date)
      .whereIf(!!end_date, 'i.letter_date <= ?', end_date);
    
    if (search) {
      const s = `%${search}%`;
      qb.where('(i.sequence_number LIKE ? OR i.letter_number LIKE ? OR i.subject LIKE ? OR i.sender_entity LIKE ?)', s, s, s, s);
    }

    const countQuery = `SELECT COUNT(*) as total ${qb.buildCountQuery()}`;
    const countRes = await this.db.prepare(countQuery).get(...qb.buildParams());
    const total = countRes?.total || 0;

    qb.orderBy('i.registration_date', 'DESC');
    const pagination = qb.paginate(page, pageSize);

    const dataQuery = `
      SELECT i.*, d.name_ar as assigned_dept_name_ar, d.name_en as assigned_dept_name_en, u.name as assigned_user_name
      ${qb.buildDataQuery()}
    `;
    
    const data = await this.db.prepare(dataQuery).all(...qb.buildParams(pagination));
    
    return {
      data,
      pagination: computePaginationMeta(page, pageSize, total)
    };
  }

  static async createIncoming(data: any, userId: string | number) {
    const { 
      letter_number, sender_entity, sender_entity_type, subject, letter_date, 
      receipt_date, classification, priority, method, receiving_dept_id, 
      assigned_dept_id, assigned_user_id, follow_up_required, follow_up_date, 
      response_required, response_due_date, notes 
    } = data;

    const year = new Date().getFullYear();
    // Atomic, race-free numbering via UPSERT RETURNING (finding 1.19 → 2.19).
    // The previous approach selected the latest row by descending UUID id
    // (arbitrary, non-monotonic) and was non-atomic, so concurrent inserts could
    // duplicate a sequence number. `NumberingService.nextCounter` is atomic.
    const nextNum = await NumberingService.nextCounter('correspondence_incoming', String(year));
    const sequence_number = `INC-${year}-${nextNum.toString().padStart(4, '0')}`;

    const result = await this.db.prepare(`
      INSERT INTO incoming_correspondence (
        sequence_number, letter_number, sender_entity, sender_entity_type, subject, 
        letter_date, receipt_date, classification, priority, method, 
        receiving_dept_id, assigned_dept_id, assigned_user_id, 
        follow_up_required, follow_up_date, response_required, response_due_date, 
        notes, created_by
      ) VALUES (?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::uuid, ?::uuid, ?::uuid, ?::integer, ?::text, ?::integer, ?::text, ?::text, ?::uuid)
    `).run(
      sequence_number, letter_number, sender_entity, sender_entity_type, subject, 
      letter_date, receipt_date, classification, priority, method, 
      receiving_dept_id, assigned_dept_id, assigned_user_id, 
      follow_up_required ? 1 : 0, follow_up_date, response_required ? 1 : 0, response_due_date, 
      notes, userId
    );

    // --- AUTOMATION: Send event to n8n ---
    try {
      await N8nService.sendEvent('incoming_correspondence.created', {
        id: result.lastInsertRowid,
        sequence_number,
        subject,
        sender_entity
      });
    } catch (err) {
      logger.error('[Automation Error] Failed to dispatch incoming_correspondence.created event:', err);
    }

    return { id: result.lastInsertRowid, sequence_number };
  }

  static async updateStatus(type: string, id: string | number, newStatus: string, notes: string, userId: string | number) {
    const table = this.db.validateIdentifier(type === 'outgoing' ? 'outgoing_letters' : 'incoming_correspondence');
    const dbType = type === 'incoming' ? 'Incoming' : 'Outgoing';

    // Captured inside the transaction for the post-commit webhook dispatch.
    let oldStatus: any = null;

    await this.db.transaction(async () => {
      const oldRecord = await this.db.prepare(`SELECT status FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id);
      if (!oldRecord) throw new NotFoundError("Record not found");

      await this.db.prepare(`UPDATE ${table} SET status = ?::text, updated_at = CURRENT_TIMESTAMP WHERE id = ?::uuid AND deleted_at IS NULL`).run(newStatus, id);
      
      await this.db.prepare(`
        INSERT INTO correspondence_status_history (correspondence_id, correspondence_type, old_status, new_status, changed_by, notes)
        VALUES (?::uuid, ?::text, ?::text, ?::text, ?::uuid, ?::text)
      `).run(id, dbType, oldRecord.status, newStatus, userId, notes);

      oldStatus = oldRecord.status;
    });

    // --- AUTOMATION: Send event to n8n (after commit, outside transaction) ---
    // External webhooks must never run inside the DB transaction, and a webhook
    // failure must not roll back the already-committed update (finding 1.14 → 2.14).
    try {
      await N8nService.sendEvent('correspondence.status_changed', {
        id,
        type,
        oldStatus,
        newStatus,
        changedBy: userId
      });
    } catch (err) {
      logger.error('[Automation Error] Failed to dispatch correspondence.status_changed event:', err);
    }

    return { oldStatus };
  }

  static async refer(data: any, userId: string | number) {
    const { incoming_id, to_dept_id, to_user_id, notes } = data;
    
    await this.db.transaction(async () => {
      await this.db.prepare(`
        INSERT INTO correspondence_referrals (incoming_id, from_user_id, to_dept_id, to_user_id, notes)
        VALUES (?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::text)
      `).run(incoming_id, userId, to_dept_id, to_user_id, notes);

      // Update incoming status to 'Referred'
      await this.db.prepare("UPDATE incoming_correspondence SET status = 'Referred', assigned_dept_id = ?::uuid, assigned_user_id = ?::uuid, updated_at = CURRENT_TIMESTAMP WHERE id = ?::uuid")
        .run(to_dept_id, to_user_id, incoming_id);
    });
  }

  static async link(data: any, userId: string | number) {
    const { incoming_id, outgoing_id, link_type } = data;
    await this.db.prepare("INSERT INTO correspondence_links (incoming_id, outgoing_id, link_type, linked_by) VALUES (?::uuid, ?::uuid, ?::text, ?::uuid)")
      .run(incoming_id, outgoing_id, link_type || 'Reply', userId);
  }

  static async archive(type: string, id: string | number) {
    const table = this.db.validateIdentifier(type === 'incoming' ? 'incoming_correspondence' : 'outgoing_letters');
    // Exclude soft-deleted rows and treat a no-op UPDATE as a 404, matching the
    // updateOutgoing/updateIncoming/deleteOutgoing/deleteIncoming sibling pattern
    // (finding 1.3 -> 2.3): a soft-deleted row must not be re-archived, and
    // archiving a missing id must not silently succeed.
    const result = await this.db.prepare(`UPDATE ${table} SET is_archived = 1, status = 'Archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?::uuid AND deleted_at IS NULL`).run(id);

    if (result.changes === 0) {
      throw new NotFoundError('Correspondence record not found');
    }
  }

  static async getArchive(filters: any) {
    const { search, type, page = 1, pageSize = 15 } = filters;

    let query = "";
    let countQuery = "";
    
    // We instantiate generic QueryBuilders assuming filtering applies equally
    // Since we handle combined differently, we conditionally build queries.

    if (type === 'incoming') {
      const qb = new QueryBuilder(`FROM incoming_correspondence`)
        .where("is_archived = 1")
        .where("deleted_at IS NULL");
      if (search) {
        qb.where("(sequence_number LIKE ? OR subject LIKE ? OR sender_entity LIKE ?)", `%${search}%`, `%${search}%`, `%${search}%`);
      }
      countQuery = `SELECT COUNT(*) as total ${qb.buildCountQuery()}`;
      const countRes = await this.db.prepare(countQuery).get(...qb.buildParams());
      qb.orderBy('updated_at', 'DESC');
      const pagination = qb.paginate(page, pageSize);
      const data = await this.db.prepare(`SELECT *, 'Incoming' as type, sender_entity as entity ${qb.buildDataQuery()}`).all(...qb.buildParams(pagination));
      return { data, pagination: computePaginationMeta(page, pageSize, countRes?.total || 0) };
      
    } else if (type === 'outgoing') {
      const qb = new QueryBuilder(`FROM outgoing_letters`)
        .where("is_archived = 1")
        .where("deleted_at IS NULL");
      if (search) {
        qb.where("(sequence_number LIKE ? OR subject LIKE ? OR recipient_entity LIKE ?)", `%${search}%`, `%${search}%`, `%${search}%`);
      }
      countQuery = `SELECT COUNT(*) as total ${qb.buildCountQuery()}`;
      const countRes = await this.db.prepare(countQuery).get(...qb.buildParams());
      qb.orderBy('updated_at', 'DESC');
      const pagination = qb.paginate(page, pageSize);
      const data = await this.db.prepare(`SELECT *, 'Outgoing' as type, recipient_entity as entity ${qb.buildDataQuery()}`).all(...qb.buildParams(pagination));
      return { data, pagination: computePaginationMeta(page, pageSize, countRes?.total || 0) };
      
    } else {
      // Combined Logic: build separate QueryBuilders for each table to avoid fragile string replacement
      const incQb = new QueryBuilder(`FROM incoming_correspondence`)
        .where("is_archived = 1")
        .where("deleted_at IS NULL");
      const outQb = new QueryBuilder(`FROM outgoing_letters`)
        .where("is_archived = 1")
        .where("deleted_at IS NULL");
      
      if (search) {
        const s = `%${search}%`;
        incQb.where("(sequence_number LIKE ? OR subject LIKE ? OR sender_entity LIKE ?)", s, s, s);
        outQb.where("(sequence_number LIKE ? OR subject LIKE ? OR recipient_entity LIKE ?)", s, s, s);
      }

      const incQuery = `SELECT id, sequence_number, subject, sender_entity as entity, updated_at, 'Incoming' as type, is_archived ${incQb.buildDataQuery()}`;
      const outQuery = `SELECT id, sequence_number, subject, recipient_entity as entity, updated_at, 'Outgoing' as type, is_archived ${outQb.buildDataQuery()}`;
      
      query = `SELECT * FROM (${incQuery} UNION ALL ${outQuery}) as combined`;
      countQuery = `SELECT COUNT(*) as total FROM (${incQuery} UNION ALL ${outQuery}) as combined`;
      
      const allParams = [...incQb.buildParams(), ...outQb.buildParams()];
      const countRes = await this.db.prepare(countQuery).get(...allParams);
      
      // Finding 1.5 -> 2.5: use the same (route-clamped) numeric page/pageSize as the
      // single-type branches above instead of re-deriving an UNBOUNDED `Number(pageSize) || 15`.
      // The effective LIMIT is therefore always bounded by whatever parsePaginationParams clamped
      // at the edge, consistently across all three branches.
      const limit = pageSize;
      const offset = (page - 1) * pageSize;
      
      const data = await this.db.prepare(`${query} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...allParams, limit, offset);
      
      return {
        data,
        pagination: computePaginationMeta(page, pageSize, countRes?.total || 0)
      };
    }
  }

  static async getAttachments(type: string, id: string | number) {
    const dbType = type === 'incoming' ? 'Incoming' : 'Outgoing';
    return await this.db.prepare("SELECT id, file_name, file_type, uploaded_at, description FROM correspondence_attachments WHERE correspondence_type = ? AND correspondence_id = ?")
      .all(dbType, id);
  }

  static async addAttachment(data: any, userId: string | number) {
    const { correspondence_id, correspondence_type, file_name, file_type, file_data, description } = data;
    // Normalize the lowercase edge value ('incoming'/'outgoing') to the capitalized
    // 'Incoming'/'Outgoing' stored in the correspondence_type column, matching the
    // dbType mapping used in updateStatus/getAttachments/getDetails (finding 1.1 -> 2.1).
    const dbType = correspondence_type === 'incoming' ? 'Incoming' : 'Outgoing';
    await this.db.prepare(`
      INSERT INTO correspondence_attachments (correspondence_id, correspondence_type, file_name, file_type, file_data, description, uploaded_by)
      VALUES (?::uuid, ?::text, ?::text, ?::text, ?::text, ?::text, ?::uuid)
    `).run(correspondence_id, dbType, file_name, file_type, file_data, description, userId);
  }

  static async getStats() {
    const [incomingStats, outgoingCount] = await Promise.all([
      this.db.prepare(`
        SELECT
          COUNT(*) FILTER (WHERE NOT is_archived) as total_incoming,
          COUNT(*) FILTER (WHERE response_required = true AND status != 'Closed' AND NOT is_archived) as pending_response,
          COUNT(*) FILTER (WHERE follow_up_required = true AND NOT is_archived) as follow_up,
          COUNT(*) FILTER (WHERE is_archived) as archived
        FROM incoming_correspondence
        WHERE deleted_at IS NULL
      `).get() as Promise<any>,
      this.db.prepare("SELECT COUNT(*) as count FROM outgoing_letters WHERE deleted_at IS NULL").get() as Promise<any>,
    ]);

    return {
      total_incoming: Number(incomingStats?.total_incoming || 0),
      total_outgoing: Number(outgoingCount?.count || 0),
      pending_response: Number(incomingStats?.pending_response || 0),
      follow_up: Number(incomingStats?.follow_up || 0),
      archived: Number(incomingStats?.archived || 0),
    };
  }

  static async getDetails(type: string, id: string | number) {
    const table = this.db.validateIdentifier(type === 'outgoing' ? 'outgoing_letters' : 'incoming_correspondence');
    const dbType = type === 'incoming' ? 'Incoming' : 'Outgoing';
    
    let record;
    if (type === 'outgoing') {
      record = await this.db.prepare(`
        SELECT r.*, u.name as creator_name
        FROM ${table} r
        LEFT JOIN users u ON r.created_by = u.id
        WHERE r.id = ?
      `).get(id);
    } else {
      const deptField = 'r.assigned_dept_id';
      record = await this.db.prepare(`
        SELECT r.*, d.name_ar as dept_name_ar, d.name_en as dept_name_en, u.name as creator_name
        FROM ${table} r
        LEFT JOIN org_entities d ON ${deptField} = d.id
        LEFT JOIN users u ON r.created_by = u.id
        WHERE r.id = ?
      `).get(id);
    }

    if (!record) throw new NotFoundError("Record not found");

    const [attachments, history, referrals] = await Promise.all([
      this.db.prepare("SELECT id, file_name, file_type, uploaded_at, description FROM correspondence_attachments WHERE correspondence_type = ? AND correspondence_id = ?").all(dbType, id),
      this.db.prepare("SELECT h.*, u.name as user_name FROM correspondence_status_history h LEFT JOIN users u ON h.changed_by = u.id WHERE correspondence_type = ? AND correspondence_id = ? ORDER BY h.change_date DESC").all(dbType, id),
      type !== 'outgoing'
        ? this.db.prepare(`
            SELECT r.*, u1.name as from_user, u2.name as to_user, d.name_ar as to_dept
            FROM correspondence_referrals r
            LEFT JOIN users u1 ON r.from_user_id = u1.id
            LEFT JOIN users u2 ON r.to_user_id = u2.id
            LEFT JOIN org_entities d ON r.to_dept_id = d.id
            WHERE r.incoming_id = ?
            ORDER BY r.referral_date DESC
          `).all(id)
        : Promise.resolve([]),
    ]);

    const links: Record<string, unknown>[] = [];

    return { main: record, attachments, history, links, referrals };
  }

  static async getOutgoing(page = 1, pageSize = 10) {
    const offset = (page - 1) * pageSize;
    const countRes = await this.db.prepare(`SELECT COUNT(*) as total FROM outgoing_letters WHERE deleted_at IS NULL`).get<{ total: number }>();
    const total = countRes?.total || 0;

    const data = await this.db.prepare("SELECT id, sequence_number, letter_date, recipient_entity, subject, classification, sending_method, status, is_archived, created_at, updated_at, created_by FROM outgoing_letters WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?").all(pageSize, offset);
    
    return {
      data,
      pagination: computePaginationMeta(page, pageSize, total)
    };
  }

  static async createOutgoing(data: any, userId: string | number) {
    const { letter_date, recipient_entity, subject, classification, sending_method, attachment_file } = data;
    
    // Auto-generate sequence number: OUT-YYYY-NNNN
    const year = new Date().getFullYear();
    // Atomic, race-free numbering via UPSERT RETURNING (finding 1.19 → 2.19),
    // replacing the previous non-atomic ordering by descending UUID id.
    const nextNum = await NumberingService.nextCounter('correspondence_outgoing', String(year));
    const sequence_number = `OUT-${year}-${nextNum.toString().padStart(4, '0')}`;

    const stmt = this.db.prepare(`
      INSERT INTO outgoing_letters (sequence_number, letter_date, recipient_entity, subject, classification, sending_method, attachment_file, created_by)
      VALUES (?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::uuid)
    `);
    const result = await stmt.run(sequence_number, letter_date, recipient_entity, subject, classification, sending_method, attachment_file, userId);
    
    // --- AUTOMATION: Send event to n8n ---
    try {
      await N8nService.sendEvent('outgoing_correspondence.created', {
        id: result.lastInsertRowid,
        sequence_number,
        subject,
        recipient_entity
      });
    } catch (err) {
      logger.error('[Automation Error] Failed to dispatch outgoing_correspondence.created event:', err);
    }

    return { id: result.lastInsertRowid, sequence_number };
  }

  static async updateOutgoing(id: string | number, data: any) {
    const fields: string[] = [];
    const values: any[] = [];

    if (data.letter_date !== undefined) { fields.push('letter_date = ?::text'); values.push(data.letter_date); }
    if (data.recipient_entity !== undefined) { fields.push('recipient_entity = ?::text'); values.push(data.recipient_entity); }
    if (data.subject !== undefined) { fields.push('subject = ?::text'); values.push(data.subject); }
    if (data.classification !== undefined) { fields.push('classification = ?::text'); values.push(data.classification); }
    if (data.sending_method !== undefined) { fields.push('sending_method = ?::text'); values.push(data.sending_method); }
    if (data.attachment_file !== undefined) { fields.push('attachment_file = ?::text'); values.push(data.attachment_file); }

    if (fields.length === 0) return;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    const result = await this.db.prepare(`UPDATE outgoing_letters SET ${fields.join(', ')} WHERE id = ?::uuid AND deleted_at IS NULL`).run(...values, id);

    if (result.changes === 0) {
      throw new NotFoundError('Outgoing correspondence record not found');
    }

    // --- AUTOMATION: Send event to n8n ---
    try {
      await N8nService.sendEvent('outgoing_correspondence.updated', { id, updates: data });
    } catch (err) {
      logger.error('[Automation Error] Failed to dispatch outgoing_correspondence.updated event:', err);
    }
  }

  static async deleteOutgoing(id: string | number) {
    // Soft-delete on the soft-delete table instead of hard-deleting (finding
    // 1.32 → 2.32). `outgoing_letters` carries a `deleted_at` column; mark the
    // row deleted rather than physically removing it.
    const result = await this.db.prepare("UPDATE outgoing_letters SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?::uuid AND deleted_at IS NULL").run(id);

    if (result.changes === 0) {
      throw new NotFoundError('Outgoing correspondence record not found');
    }

    // --- AUTOMATION: Send event to n8n ---
    try {
      await N8nService.sendEvent('outgoing_correspondence.deleted', { id });
    } catch (err) {
      logger.error('[Automation Error] Failed to dispatch outgoing_correspondence.deleted event:', err);
    }
  }

  static async updateIncoming(id: string | number, data: any) {
    const fieldMap: Record<string, string> = {
      letter_number: '?::text', sender_entity: '?::text', sender_entity_type: '?::text',
      subject: '?::text', letter_date: '?::text', receipt_date: '?::text',
      classification: '?::text', priority: '?::text', method: '?::text',
      receiving_dept_id: '?::uuid', assigned_dept_id: '?::uuid', assigned_user_id: '?::uuid',
      follow_up_date: '?::text', response_due_date: '?::text', notes: '?::text',
    };

    const fields: string[] = [];
    const values: any[] = [];

    for (const [key, cast] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${key} = ${cast}`);
        values.push(data[key]);
      }
    }

    // Boolean fields stored as integer
    if (data.follow_up_required !== undefined) {
      fields.push('follow_up_required = ?::integer');
      values.push(data.follow_up_required ? 1 : 0);
    }
    if (data.response_required !== undefined) {
      fields.push('response_required = ?::integer');
      values.push(data.response_required ? 1 : 0);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    const result = await this.db.prepare(`UPDATE incoming_correspondence SET ${fields.join(', ')} WHERE id = ?::uuid AND deleted_at IS NULL`).run(...values, id);

    if (result.changes === 0) {
      throw new NotFoundError('Incoming correspondence record not found');
    }

    // --- AUTOMATION: Send event to n8n ---
    try {
      await N8nService.sendEvent('incoming_correspondence.updated', { id, updates: data });
    } catch (err) {
      logger.error('[Automation Error] Failed to dispatch incoming_correspondence.updated event:', err);
    }
  }

  static async deleteIncoming(id: string | number) {
    // Soft-delete on the soft-delete tables instead of hard-deleting (finding
    // 1.32 → 2.32). `incoming_correspondence` and `correspondence_attachments`
    // both carry a `deleted_at` column, so mark them deleted rather than
    // physically removing them. Related rows in non-soft-delete tables
    // (referrals/links/status history) are preserved alongside the soft-deleted
    // parent for auditability.
    let changes = 0;
    await this.db.transaction(async () => {
      await this.db.prepare("UPDATE correspondence_attachments SET deleted_at = CURRENT_TIMESTAMP WHERE correspondence_type = 'Incoming' AND correspondence_id = ? AND deleted_at IS NULL").run(id);
      const result = await this.db.prepare("UPDATE incoming_correspondence SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").run(id);
      changes = result.changes;
    });

    if (changes === 0) {
      throw new NotFoundError('Incoming correspondence record not found');
    }

    // --- AUTOMATION: Send event to n8n ---
    try {
      await N8nService.sendEvent('incoming_correspondence.deleted', { id });
    } catch (err) {
      logger.error('[Automation Error] Failed to dispatch incoming_correspondence.deleted event:', err);
    }
  }
}

