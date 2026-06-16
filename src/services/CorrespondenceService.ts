import { db } from '../db/index';
import { NotFoundError, ValidationError } from '../utils/errors';
import { QueryBuilder } from '../utils/QueryBuilder';
import { N8nService } from '../utils/n8nService';
import { NumberingService } from './NumberingService';
import { computePaginationMeta } from '../utils/paginationService';

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
    await N8nService.sendEvent('incoming_correspondence.created', {
      id: result.lastInsertRowid,
      sequence_number,
      subject,
      sender_entity
    });

    return { id: result.lastInsertRowid, sequence_number };
  }

  static async updateStatus(type: string, id: string | number, newStatus: string, notes: string, userId: string | number) {
    const table = this.db.validateIdentifier(type === 'Outgoing' ? 'outgoing_letters' : 'incoming_correspondence');

    // Captured inside the transaction for the post-commit webhook dispatch.
    let oldStatus: any = null;

    await this.db.transaction(async () => {
      const oldRecord = await this.db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id);
      if (!oldRecord) throw new NotFoundError("Record not found");

      await this.db.prepare(`UPDATE ${table} SET status = ?::text, updated_at = CURRENT_TIMESTAMP WHERE id = ?::uuid`).run(newStatus, id);
      
      await this.db.prepare(`
        INSERT INTO correspondence_status_history (correspondence_id, correspondence_type, old_status, new_status, changed_by, notes)
        VALUES (?::uuid, ?::text, ?::text, ?::text, ?::uuid, ?::text)
      `).run(id, type, oldRecord.status, newStatus, userId, notes);

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
      console.error('[Automation Error] Failed to dispatch correspondence.status_changed event:', err);
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
    const table = this.db.validateIdentifier(type === 'Incoming' ? 'incoming_correspondence' : 'outgoing_letters');
    await this.db.prepare(`UPDATE ${table} SET is_archived = 1, status = 'Archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?::uuid`).run(id);
  }

  static async getArchive(filters: any) {
    const { search, type, page = 1, pageSize = 15 } = filters;

    let query = "";
    let countQuery = "";
    
    // We instantiate generic QueryBuilders assuming filtering applies equally
    // Since we handle combined differently, we conditionally build queries.

    if (type === 'Incoming') {
      const qb = new QueryBuilder(`FROM incoming_correspondence`)
        .where("is_archived = 1");
      if (search) {
        qb.where("(sequence_number LIKE ? OR subject LIKE ? OR sender_entity LIKE ?)", `%${search}%`, `%${search}%`, `%${search}%`);
      }
      countQuery = `SELECT COUNT(*) as total ${qb.buildCountQuery()}`;
      const countRes = await this.db.prepare(countQuery).get(...qb.buildParams());
      qb.orderBy('updated_at', 'DESC');
      const pagination = qb.paginate(page, pageSize);
      const data = await this.db.prepare(`SELECT *, 'Incoming' as type, sender_entity as entity ${qb.buildDataQuery()}`).all(...qb.buildParams(pagination));
      return { data, pagination: computePaginationMeta(page, pageSize, countRes?.total || 0) };
      
    } else if (type === 'Outgoing') {
      const qb = new QueryBuilder(`FROM outgoing_letters`)
        .where("is_archived = 1");
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
      // Combined Logic
      const qb = new QueryBuilder("").where("is_archived = 1");
      if (search) {
         const s = `%${search}%`;
         qb.where("(sequence_number LIKE ? OR subject LIKE ? OR search_column LIKE ?)", s, s, s);
      }
      
      const whereBlock = qb.getWhereBlock();
      const incWhere = whereBlock.replace('search_column', 'sender_entity');
      const outWhere = whereBlock.replace('search_column', 'recipient_entity');

      const incQuery = `SELECT id, sequence_number, subject, sender_entity as entity, updated_at, 'Incoming' as type, is_archived FROM incoming_correspondence ${incWhere}`;
      const outQuery = `SELECT id, sequence_number, subject, recipient_entity as entity, updated_at, 'Outgoing' as type, is_archived FROM outgoing_letters ${outWhere}`;
      
      query = `SELECT * FROM (${incQuery} UNION ALL ${outQuery}) as combined`;
      countQuery = `SELECT COUNT(*) as total FROM (${incQuery} UNION ALL ${outQuery}) as combined`;
      
      const countRes = await this.db.prepare(countQuery).get(...qb.buildParams(), ...qb.buildParams()); // Apply to both halves
      const pagination = qb.paginate(page, pageSize);
      // We pass the parameters twice because of the UNION
      const data = await this.db.prepare(`${query} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...qb.buildParams(), ...qb.buildParams(), pagination.limit, pagination.offset);
      
      return {
        data,
        pagination: computePaginationMeta(page, pageSize, countRes?.total || 0)
      };
    }
  }

  static async getAttachments(type: string, id: string | number) {
    return await this.db.prepare("SELECT id, file_name, file_type, uploaded_at, description FROM correspondence_attachments WHERE correspondence_type = ? AND correspondence_id = ?")
      .all(type, id);
  }

  static async addAttachment(data: any, userId: string | number) {
    const { correspondence_id, correspondence_type, file_name, file_type, file_data, description } = data;
    await this.db.prepare(`
      INSERT INTO correspondence_attachments (correspondence_id, correspondence_type, file_name, file_type, file_data, description, uploaded_by)
      VALUES (?::uuid, ?::text, ?::text, ?::text, ?::text, ?::text, ?::uuid)
    `).run(correspondence_id, correspondence_type, file_name, file_type, file_data, description, userId);
  }

  static async getStats() {
    return {
      total_incoming: (await this.db.prepare("SELECT COUNT(*) as count FROM incoming_correspondence WHERE is_archived = 0").get() as any).count,
      total_outgoing: (await this.db.prepare("SELECT COUNT(*) as count FROM outgoing_letters").get() as any).count,
      pending_response: (await this.db.prepare("SELECT COUNT(*) as count FROM incoming_correspondence WHERE response_required = 1 AND status != 'Closed' AND is_archived = 0").get() as any).count,
      follow_up: (await this.db.prepare("SELECT COUNT(*) as count FROM incoming_correspondence WHERE follow_up_required = 1 AND is_archived = 0").get() as any).count,
      archived: (await this.db.prepare("SELECT COUNT(*) as count FROM incoming_correspondence WHERE is_archived = 1").get() as any).count
    };
  }

  static async getDetails(type: string, id: string | number) {
    const table = this.db.validateIdentifier(type === 'outgoing' ? 'outgoing_letters' : 'incoming_correspondence');
    
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

    const attachments = await this.db.prepare("SELECT id, file_name, file_type, uploaded_at, description FROM correspondence_attachments WHERE correspondence_type = ? AND correspondence_id = ?").all(type, id);
    const history = await this.db.prepare("SELECT h.*, u.name as user_name FROM correspondence_status_history h LEFT JOIN users u ON h.changed_by = u.id WHERE correspondence_type = ? AND correspondence_id = ? ORDER BY h.change_date DESC").all(type, id);
    
    const links: Record<string, unknown>[] = [];
    let referrals: Record<string, unknown>[] = [];

    if (type !== 'outgoing') {
      referrals = await this.db.prepare(`
        SELECT r.*, u1.name as from_user, u2.name as to_user, d.name_ar as to_dept
        FROM correspondence_referrals r
        LEFT JOIN users u1 ON r.from_user_id = u1.id
        LEFT JOIN users u2 ON r.to_user_id = u2.id
        LEFT JOIN org_entities d ON r.to_dept_id = d.id
        WHERE r.incoming_id = ?
        ORDER BY r.referral_date DESC
      `).all(id);
    }

    return { main: record, attachments, history, links, referrals };
  }

  static async getOutgoing(page = 1, pageSize = 10) {
    const offset = (page - 1) * pageSize;
    const countRes = await this.db.prepare(`SELECT COUNT(*) as total FROM outgoing_letters`).get<{ total: number }>();
    const total = countRes?.total || 0;

    const data = await this.db.prepare("SELECT id, sequence_number, letter_date, recipient_entity, subject, classification, sending_method, status, is_archived, created_at, updated_at, created_by FROM outgoing_letters ORDER BY created_at DESC LIMIT ? OFFSET ?").all(pageSize, offset);
    
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
    await N8nService.sendEvent('outgoing_correspondence.created', {
      id: result.lastInsertRowid,
      sequence_number,
      subject,
      recipient_entity
    });

    return { id: result.lastInsertRowid, sequence_number };
  }

  static async updateOutgoing(id: string | number, data: any) {
    const { letter_date, recipient_entity, subject, classification, sending_method, attachment_file } = data;
    
    if (attachment_file !== undefined) {
      await this.db.prepare(`
        UPDATE outgoing_letters 
        SET letter_date = ?::text, recipient_entity = ?::text, subject = ?::text, classification = ?::text, sending_method = ?::text, attachment_file = ?::text
        WHERE id = ?::uuid
      `).run(letter_date, recipient_entity, subject, classification, sending_method, attachment_file, id);
    } else {
      await this.db.prepare(`
        UPDATE outgoing_letters 
        SET letter_date = ?::text, recipient_entity = ?::text, subject = ?::text, classification = ?::text, sending_method = ?::text
        WHERE id = ?::uuid
      `).run(letter_date, recipient_entity, subject, classification, sending_method, id);
    }

    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('outgoing_correspondence.updated', {
      id,
      updates: data
    });
  }

  static async deleteOutgoing(id: string | number) {
    // Soft-delete on the soft-delete table instead of hard-deleting (finding
    // 1.32 → 2.32). `outgoing_letters` carries a `deleted_at` column; mark the
    // row deleted rather than physically removing it.
    await this.db.prepare("UPDATE outgoing_letters SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?::uuid AND deleted_at IS NULL").run(id);

    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('outgoing_correspondence.deleted', {
      id
    });
  }

  static async updateIncoming(id: string | number, data: any) {
    const { 
      letter_number, sender_entity, sender_entity_type, subject, letter_date, 
      receipt_date, classification, priority, method, receiving_dept_id, 
      assigned_dept_id, assigned_user_id, follow_up_required, follow_up_date, 
      response_required, response_due_date, notes 
    } = data;

    await this.db.prepare(`
      UPDATE incoming_correspondence SET 
        letter_number = ?::text, sender_entity = ?::text, sender_entity_type = ?::text, subject = ?::text, 
        letter_date = ?::text, receipt_date = ?::text, classification = ?::text, priority = ?::text, method = ?::text, 
        receiving_dept_id = ?::uuid, assigned_dept_id = ?::uuid, assigned_user_id = ?::uuid, 
        follow_up_required = ?::integer, follow_up_date = ?::text, response_required = ?::integer, response_due_date = ?::text, 
        notes = ?::text, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?::uuid
    `).run(
      letter_number, sender_entity, sender_entity_type, subject, 
      letter_date, receipt_date, classification, priority, method, 
      receiving_dept_id, assigned_dept_id, assigned_user_id, 
      follow_up_required ? 1 : 0, follow_up_date, response_required ? 1 : 0, response_due_date, 
      notes, id
    );

    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('incoming_correspondence.updated', {
      id,
      updates: data
    });
  }

  static async deleteIncoming(id: string | number) {
    // Soft-delete on the soft-delete tables instead of hard-deleting (finding
    // 1.32 → 2.32). `incoming_correspondence` and `correspondence_attachments`
    // both carry a `deleted_at` column, so mark them deleted rather than
    // physically removing them. Related rows in non-soft-delete tables
    // (referrals/links/status history) are preserved alongside the soft-deleted
    // parent for auditability.
    await this.db.transaction(async () => {
      await this.db.prepare("UPDATE correspondence_attachments SET deleted_at = CURRENT_TIMESTAMP WHERE correspondence_type = 'Incoming' AND correspondence_id = ? AND deleted_at IS NULL").run(id);
      await this.db.prepare("UPDATE incoming_correspondence SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").run(id);
    });

    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent('incoming_correspondence.deleted', {
      id
    });
  }
}

