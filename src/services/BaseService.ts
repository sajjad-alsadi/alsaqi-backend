import { db } from '../db/index';
import { NotFoundError, ValidationError } from '../utils/errors';
import { AppCodeGenerator } from '../utils/AppCodeGenerator';
import { enqueueEvent } from './transactionalEvents';
import { computePaginationMeta, DEFAULT_PAGE_SIZE } from '../utils/paginationService';
import { checkWhitelist } from './columnWhitelist';
import { buildSearchClause } from './searchColumns';
import { isKeysetTable, keysetPaginate, clampKeysetPageSize } from '../utils/cursorPagination';
import { getCachedCount, buildCountCacheKey } from './countCache';
import { AuditChainService } from './AuditChainService';

export class BaseService {
  protected static db = db;

  /**
   * Tables that carry a `deleted_at` column and therefore participate in the
   * soft-delete model (derived from `database/schema.sql`). For these tables the
   * default {@link delete} path performs an `UPDATE ... SET deleted_at = now()`
   * rather than a physical `DELETE` (Req 25.1). Tables not listed here have no
   * `deleted_at` column and can only be removed physically.
   */
  static readonly SOFT_DELETE_TABLES: ReadonlySet<string> = new Set<string>([
    'audit_programs',
    'audit_plans',
    'risk_register',
    'compliance_items',
    'audit_tasks',
    'audit_findings',
    'recommendations',
    'audit_evidence',
    'audit_reports',
    'fraud_log',
    'incoming_correspondence',
    // The real outgoing-correspondence table is `outgoing_letters` (finding
    // 1.32 → 2.32). The previous `outgoing_correspondence` entry referenced a
    // legacy/unused table, so the soft-delete path never applied to the table the
    // application actually writes to.
    'outgoing_letters',
    'correspondence_attachments',
  ]);

  /** Whether the given table has a `deleted_at` column (soft-delete capable). */
  static hasSoftDelete(tableName: string): boolean {
    return BaseService.SOFT_DELETE_TABLES.has(tableName);
  }

  /**
   * Appends an audit-trail entry. Delegates to the single canonical hash-chain
   * writer, {@link AuditChainService.append} (Requirement 7.1, 27.1, 27.4) —
   * the duplicated inline hash-chain writer that previously lived here has been
   * removed so exactly one audit-append implementation remains.
   *
   * Append failures are now SURFACED (re-thrown) rather than swallowed
   * (Requirement 2.5): a failing append leaves a gap in the tamper-evident
   * chain, so the failure must propagate to the caller and be detectable rather
   * than silently logged and dropped. On the happy path the append succeeds and
   * nothing is thrown, so well-behaved primary operations are unaffected.
   */
  static async logAudit(username: string, action: string, module: string, details: string) {
    try {
      await AuditChainService.append({ user: username, action, module, details });
    } catch (error) {
      console.error("[System Log Error] Failed to insert audit trail:", error);
      throw error;
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

  static async findAll(
    tableName: string,
    options: {
      page?: number;
      pageSize?: number;
      orderBy?: string;
      where?: Record<string, any>;
      select?: string[];
      includeDeleted?: boolean;
      cursor?: string | null;
      sortDirection?: 'ASC' | 'DESC';
    } = {}
  ) {
    const { page = 1, pageSize, orderBy = 'id DESC', where = {}, select, includeDeleted = false, cursor, sortDirection } = options;

    const validatedTable = this.db.validateIdentifier(tableName);

    // Safe select columns
    const safeSelect = select && select.length > 0
      ? select.filter(s => /^[a-zA-Z0-9_]+$/.test(s)).join(', ')
      : '*';

    // Build the where conditions shared by both the offset and keyset paths:
    // explicit equality filters, soft-delete exclusion, and the configurable
    // search clause.
    const { search, ...restWhere } = where;
    const whereConditions: string[] = [];
    const whereValues: any[] = [];

    for (const key of Object.keys(restWhere)) {
      whereConditions.push(`${this.db.validateIdentifier(key)} = ?`);
      whereValues.push(restWhere[key]);
    }

    // Exclude soft-deleted records from standard queries (Req 25.3).
    if (!includeDeleted) {
      whereConditions.push('deleted_at IS NULL');
    }

    // Configurable, table-scoped search clause. Returns null (no clause) when the
    // table has no configured search columns or the term is empty/whitespace —
    // there is NO title/name/description fallback (Req 5.1, 5.2, 5.4).
    const searchClause = buildSearchClause(tableName, typeof search === 'string' ? search : null);
    if (searchClause) {
      whereConditions.push(searchClause.clause);
      whereValues.push(...searchClause.params);
    }

    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';

    // ── Keyset (cursor) pagination for large-table-configured endpoints ──────
    // (Req 6.1–6.6). The total count comes from a cached/estimated source no
    // older than 60s rather than a per-request COUNT(*) (Req 6.5).
    if (isKeysetTable(tableName)) {
      const additionalWhere = whereConditions.length > 0 ? whereConditions.join(' AND ') : undefined;

      const pageResult = await keysetPaginate(
        this.db,
        tableName,
        { cursor, pageSize, sortDirection },
        additionalWhere,
        whereValues,
        safeSelect
      );

      const effectivePageSize = clampKeysetPageSize(pageSize);
      const total = await getCachedCount(
        buildCountCacheKey(validatedTable, whereClause, whereValues),
        async () => {
          const countRes = await this.db.prepare(`SELECT COUNT(*) as total FROM ${validatedTable} ${whereClause}`).get(...whereValues);
          return countRes?.total || 0;
        }
      );

      return {
        data: pageResult.data,
        nextCursor: pageResult.nextCursor,
        pagination: computePaginationMeta(page, effectivePageSize, total),
      };
    }

    // ── Offset/limit pagination (default path for non-large tables) ──────────
    // Validate orderBy to prevent SQL injection.
    const orderParts = (orderBy || 'id').trim().split(/\s+/);
    const orderColumn = orderParts[0] || 'id';
    const orderDirection = (orderParts[1] || 'DESC').toUpperCase();

    if (orderColumn && !/^[a-zA-Z0-9_]+$/.test(orderColumn)) {
      throw new ValidationError(`Invalid orderBy column name: ${orderColumn}`);
    }
    if (orderDirection !== 'ASC' && orderDirection !== 'DESC') {
      throw new ValidationError(`Invalid orderBy direction: ${orderDirection}`);
    }
    const safeOrderBy = `${orderColumn} ${orderDirection}`;

    const effectiveOffsetPageSize = pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * effectiveOffsetPageSize;

    const countRes = await this.db.prepare(`SELECT COUNT(*) as total FROM ${validatedTable} ${whereClause}`).get(...whereValues);
    const total = countRes?.total || 0;

    const query = `SELECT ${safeSelect} FROM ${validatedTable} ${whereClause} ORDER BY ${safeOrderBy} LIMIT ? OFFSET ?`;
    const data = await this.db.prepare(query).all(...whereValues, effectiveOffsetPageSize, offset);

    return {
      data,
      pagination: computePaginationMeta(page, effectiveOffsetPageSize, total)
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
    // Mass-assignment prevention (Req 4.1, 4.3, 4.4): reject the ENTIRE request
    // before touching the database when the body contains any top-level key that
    // is not in the schema-derived column whitelist for the table. No row is
    // created and the error names the offending keys. This pure pre-DB check
    // returns well within the required bound (Req 4.5).
    const { ok, rejectedKeys } = checkWhitelist(tableName, data ?? {});
    if (!ok) {
      throw new ValidationError(
        `The following fields are not permitted for ${tableName}: ${rejectedKeys.join(', ')}`,
        { rejectedKeys }
      );
    }

    return await db.transaction(async () => {
      const body = this.sanitizeBody(data);

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

      // Obtain the real primary key of the inserted row via an explicit
      // `RETURNING id` executed through `get()` — mirroring how `update`/`delete`
      // already read back `RETURNING id`. This works correctly under Postgres and
      // PGlite (which have no SQLite `lastInsertRowid` concept). Using `get()`
      // (rather than `run()`) is deliberate: `get()` runs the SQL verbatim, while
      // `run()` would append its own `RETURNING *` to a `RETURNING`-less INSERT —
      // so routing the explicit `RETURNING id` through `get()` guarantees a single
      // RETURNING clause and never produces a double-RETURNING statement.
      const insertQuery = `INSERT INTO ${validatedTable} (${keys.join(",")}) VALUES (${placeholders}) RETURNING id`;
      const insertedRow = await this.db.prepare(insertQuery).get(...values) as { id: string | number } | undefined;
      const newId = insertedRow?.id;

      // --- AUTOMATION: buffer event for dispatch after commit (Req 20.1) ---
      enqueueEvent({
        name: `${tableName}.created`,
        payload: { id: newId, ...body },
      });

      return { id: newId, ...body };
    });
  }

  static async update(tableName: string, id: string | number, data: any) {
    // Mass-assignment prevention (Req 4.1, 4.3, 4.4): reject the ENTIRE request
    // before touching the database when the body contains any top-level key that
    // is not in the schema-derived column whitelist for the table. The existing
    // target row is left unchanged and the error names the offending keys
    // (Req 4.3). This pure pre-DB check returns well within the bound (Req 4.5).
    const { ok, rejectedKeys } = checkWhitelist(tableName, data ?? {});
    if (!ok) {
      throw new ValidationError(
        `The following fields are not permitted for ${tableName}: ${rejectedKeys.join(', ')}`,
        { rejectedKeys }
      );
    }

    return await db.transaction(async () => {
      const body = this.sanitizeBody(data);

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

      // --- AUTOMATION: buffer event for dispatch after commit (Req 20.1) ---
      enqueueEvent({
        name: `${tableName}.updated`,
        payload: { id, ...body },
      });

      return { id, ...body };
    });
  }

  /**
   * Default delete path. For tables that have a `deleted_at` column this performs
   * a soft delete (`UPDATE ... SET deleted_at = now()`) and never issues a hard
   * `DELETE` (Req 25.1). The soft-deleted row remains physically present and
   * retrievable via the `includeDeleted` option on `findAll`/`findById`
   * (Req 25.2, 25.3). Deleting a row whose `deleted_at` is already non-null makes
   * no change and returns a not-found error while preserving the existing
   * `deleted_at` value (Req 25.4). This path never invokes {@link hardDelete}
   * (Req 25.5). For tables without a `deleted_at` column, physical removal is the
   * only available behavior.
   */
  static async delete(tableName: string, id: string | number) {
    const validatedTable = this.db.validateIdentifier(tableName);

    return await db.transaction(async () => {
      if (this.hasSoftDelete(tableName)) {
        // Soft delete: only mark rows that are not already soft-deleted so that an
        // already-deleted target yields a not-found indication without altering the
        // preserved deleted_at value (Req 25.1, 25.4).
        const updated = await this.db
          .prepare(`UPDATE ${validatedTable} SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL RETURNING id`)
          .get(id);

        if (!updated) {
          throw new NotFoundError(`${tableName} item with ID ${id} not found`);
        }
      } else {
        // Tables without a deleted_at column have no soft-delete semantics; remove
        // the row physically. (Intentionally does not delegate to hardDelete so the
        // distinct hard-delete operation is never reached via the default path.)
        await this.db.prepare(`DELETE FROM ${validatedTable} WHERE id = ?`).run(id);
      }

      // --- AUTOMATION: buffer event for dispatch after commit (Req 20.1) ---
      // If this transaction rolls back (e.g. the not-found case above) the
      // buffered event is discarded and never dispatched (Req 20.3).
      enqueueEvent({ name: `${tableName}.deleted`, payload: { id } });

      return true;
    });
  }

  /**
   * Permanently removes a row from the database via a physical `DELETE`. This is
   * a distinctly named operation that is NEVER invoked by the default
   * {@link delete} path (Req 25.5). Callers must opt in explicitly when a hard
   * delete is genuinely required.
   */
  static async hardDelete(tableName: string, id: string | number) {
    const validatedTable = this.db.validateIdentifier(tableName);

    return await db.transaction(async () => {
      await this.db.prepare(`DELETE FROM ${validatedTable} WHERE id = ?`).run(id);

      // --- AUTOMATION: buffer event for dispatch after commit (Req 20.1) ---
      enqueueEvent({ name: `${tableName}.deleted`, payload: { id } });

      return true;
    });
  }
}


