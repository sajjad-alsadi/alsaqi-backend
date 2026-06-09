import { db } from '../db/index';
import { NotFoundError, ValidationError } from '../utils/errors';
import { AppCodeGenerator } from '../utils/AppCodeGenerator';
import { N8nService } from '../utils/n8nService';
import { computePaginationMeta } from '../utils/paginationService';
import crypto from 'crypto';

export class BaseService {
  protected static db = db;

  static async logAudit(username: string, action: string, module: string, details: string) {
    try {
      const timestamp = new Date().toISOString();
      
      // Hash chaining for tamper-evident audit trail
      let previousHash = '0';
      try {
        const lastRecord = await this.db.prepare("SELECT hash FROM audit_trail WHERE hash IS NOT NULL ORDER BY timestamp DESC LIMIT 1").get() as any;
        if (lastRecord?.hash) {
          previousHash = lastRecord.hash;
        }
      } catch (e) {
        // If hash column doesn't exist yet, continue without it
      }
      
      const recordData = `${previousHash}|${username}|${action}|${module}|${details}|${timestamp}`;
      const hash = crypto.createHash('sha256').update(recordData).digest('hex');
      
      await this.db.prepare("INSERT INTO audit_trail (\"user\", action, module, details, hash, previous_hash, timestamp) VALUES (?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::timestamp)")
        .run(username, action, module, details, hash, previousHash, timestamp);
    } catch (error) {
      console.error("[System Log Error] Failed to insert audit trail:", error);
    }
  }

  protected static sanitizeBody(body: any) {
    const sanitized = { ...body };
    Object.keys(sanitized).forEach(key => {
      // Convert empty strings to null for fields that are likely UUIDs or foreign keys
      if (sanitized[key] === "" && (key.endsWith('_id') || key === 'id' || key.includes('uuid'))) {
        sanitized[key] = null;
      }
    });
    return sanitized;
  }

  static async findAll(tableName: string, options: { page?: number; pageSize?: number; orderBy?: string; where?: Record<string, any>; select?: string[]; includeDeleted?: boolean } = {}) {
    const { page = 1, pageSize = 10, orderBy = 'id DESC', where = {}, select, includeDeleted = false } = options;
    const offset = (page - 1) * pageSize;

    const validatedTable = this.db.validateIdentifier(tableName);
    
    // Validate orderBy to prevent SQL injection
    const orderParts = (orderBy || 'id').trim().split(/\s+/);
    const orderColumn = orderParts[0] || 'id';
    const orderDirection = (orderParts[1] || 'DESC').toUpperCase();
    
    // Strict regex for column name
    if (orderColumn && !/^[a-zA-Z0-9_]+$/.test(orderColumn)) {
      throw new ValidationError(`Invalid orderBy column name: ${orderColumn}`);
    }
    // Strict match for direction
    if (orderDirection !== 'ASC' && orderDirection !== 'DESC') {
      throw new ValidationError(`Invalid orderBy direction: ${orderDirection}`);
    }
    // Final safe orderBy string
    const safeOrderBy = `${orderColumn} ${orderDirection}`;

    // Safe select columns
    const safeSelect = select && select.length > 0
      ? select.filter(s => /^[a-zA-Z0-9_]+$/.test(s)).join(', ')
      : '*';

    let whereClause = '';
    const whereValues: any[] = [];
    const { search, ...restWhere } = where;
    const whereKeys = Object.keys(restWhere);
    
    if (whereKeys.length > 0) {
      whereClause = 'WHERE ' + whereKeys.map((key, i) => `${this.db.validateIdentifier(key)} = ?`).join(' AND ');
      whereValues.push(...Object.values(restWhere));
    }

    // Exclude soft-deleted records from standard queries (Requirement 8.2)
    if (!includeDeleted) {
      if (whereClause) {
        whereClause += ' AND deleted_at IS NULL';
      } else {
        whereClause = 'WHERE deleted_at IS NULL';
      }
    }

    // Add search functionality if provided
    if (search && typeof search === 'string' && search.trim() !== '') {
      const searchPattern = `%${search.trim()}%`;
      // We'll try to find common text columns to search on based on the table name
      const searchColumns: Record<string, string[]> = {
        audit_plans: ['title', 'plan_code', 'department', 'lead_auditor'],
        audit_tasks: ['title', 'task_number', 'audit_type'],
        audit_programs: ['program_title', 'program_code', 'audit_area'],
        audit_findings: ['title', 'description', 'finding_number'],
        recommendations: ['rec_number', 'department', 'action_plan'],
        risk_register: ['risk_id', 'description', 'owner'],
        compliance_items: ['ref_number', 'title', 'notes']
      };

      const tableSearchCols = searchColumns[tableName] || ['title', 'name', 'description'].filter(c => c); // Fallback
      
      if (tableSearchCols.length > 0) {
        const searchClause = '(' + tableSearchCols.map(col => `${this.db.validateIdentifier(col)} LIKE ?`).join(' OR ') + ')';
        if (whereClause) {
          whereClause += ` AND ${searchClause}`;
        } else {
          whereClause = `WHERE ${searchClause}`;
        }
        tableSearchCols.forEach(() => whereValues.push(searchPattern));
      }
    }

    const countRes = await this.db.prepare(`SELECT COUNT(*) as total FROM ${validatedTable} ${whereClause}`).get(...whereValues);
    const total = countRes?.total || 0;

    const query = `SELECT ${safeSelect} FROM ${validatedTable} ${whereClause} ORDER BY ${safeOrderBy} LIMIT ? OFFSET ?`;
    const data = await this.db.prepare(query).all(...whereValues, pageSize, offset);

    return {
      data,
      pagination: computePaginationMeta(page, pageSize, total)
    };
  }

  static async findById(tableName: string, id: string | number, options: { includeDeleted?: boolean } = {}) {
    const { includeDeleted = false } = options;
    const validatedTable = this.db.validateIdentifier(tableName);
    const deletedFilter = includeDeleted ? '' : ' AND deleted_at IS NULL';
    const item = await this.db.prepare(`SELECT * FROM ${validatedTable} WHERE id = ?${deletedFilter}`).get(id);
    if (!item) {
      throw new NotFoundError(`${tableName} item with ID ${id} not found`);
    }
    return item;
  }

  static async create(tableName: string, data: any) {
    return await db.transaction(async () => {
      const body = this.sanitizeBody(data);
      // Only delete internal fields, ensure plan_code stays if provided
      const restrictedColumns = ['id', 'created_at', 'updated_at'];
      restrictedColumns.forEach(col => {
        if (col in body) delete body[col];
      });

      // Determine relevant code column
      const codeColumns: Record<string, string> = {
        audit_plans: 'plan_code',
        audit_programs: 'program_code',
        audit_tasks: 'task_number',
        audit_findings: 'finding_number',
        recommendations: 'rec_number',
        risk_register: 'risk_id',
        compliance_items: 'ref_number'
      };
      
      const codeCol = codeColumns[tableName];
      if (codeCol && !body[codeCol]) {
         let code: string | null = null;
         if (tableName === 'audit_findings' && body.audit_id) {
           code = await AppCodeGenerator.generateFindingCode(body.audit_id);
         } else {
           code = await AppCodeGenerator.generateCode(tableName, body.department);
         }
         if (code) body[codeCol] = code;
      }

      const keys = Object.keys(body).map(k => this.db.validateIdentifier(k));
      const values = Object.values(body);

      if (keys.length === 0) {
        throw new ValidationError("No data provided for creation");
      }

      const placeholders = keys.map(() => "?").join(",");
      const validatedTable = this.db.validateIdentifier(tableName);
      const stmt = this.db.prepare(`INSERT INTO ${validatedTable} (${keys.join(",")}) VALUES (${placeholders})`);
      const info = await stmt.run(...values) as any;

      // --- AUTOMATION: Send event to n8n ---
      await N8nService.sendEvent(`${tableName}.created`, {
        id: info.lastInsertRowid,
        ...body
      }).catch((e) => console.error("N8n send event failed", e));

      return { id: info.lastInsertRowid, ...body };
    });
  }

  static async update(tableName: string, id: string | number, data: any) {
    return await db.transaction(async () => {
      const body = this.sanitizeBody(data);
      
      // Strict exclusion of immutable/system fields to prevent Mass Assignment
      const immutableFields = [
        'id', 'created_at', 'updated_at', 
        'plan_code', 'program_code', 'task_number', 'finding_number', 
        'rec_number', 'risk_id', 'employee_id'
      ];
      immutableFields.forEach(col => delete body[col]);

      const keys = Object.keys(body).map(k => this.db.validateIdentifier(k));
      const values = Object.values(body);

      if (keys.length === 0) {
        throw new ValidationError("No data provided for update");
      }

      const setClause = keys.map(k => `${k} = ?`).join(",");
      const validatedTable = this.db.validateIdentifier(tableName);
      
      // Explicitly update updated_at timestamp
      const updateQuery = `UPDATE ${validatedTable} SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id`;
      const updatedRow = await this.db.prepare(updateQuery).get(...values, id);

      if (!updatedRow) {
        throw new NotFoundError(`${tableName} item with ID ${id} not found`);
      }

      // --- AUTOMATION: Send event to n8n ---
      await N8nService.sendEvent(`${tableName}.updated`, {
        id,
        ...body
      }).catch((e) => console.error("N8n send event failed", e));

      return { id, ...body };
    });
  }

  static async delete(tableName: string, id: string | number) {
    const validatedTable = this.db.validateIdentifier(tableName);
    await this.db.prepare(`DELETE FROM ${validatedTable} WHERE id = ?`).run(id);
    
    // --- AUTOMATION: Send event to n8n ---
    await N8nService.sendEvent(`${tableName}.deleted`, {
      id
    }).catch((e) => console.error("N8n send event failed", e));
    
    return true;
  }
}


