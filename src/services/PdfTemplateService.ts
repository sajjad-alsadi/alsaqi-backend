import { db } from '../db/index.js';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors.js';
import { isValidTemplateTypeKey, type TemplateTypeKey } from '../constants/templateTypes.js';
import {
  mapRowToTemplate,
  type PdfTemplate,
  type PdfTemplateRow,
  type CreateTemplateDto,
  type UpdateTemplateDto,
} from '../types/pdf.js';

/** Maximum allowed content size in bytes (500 KB). */
const MAX_CONTENT_BYTES = 500 * 1024;
/** Maximum allowed template name length in characters. */
const MAX_NAME_LENGTH = 200;

/**
 * PdfTemplateService — Unified CRUD service for PDF templates.
 *
 * Responsibilities:
 * - CRUD operations with versioning
 * - Ensure at most one default approved template per type
 * - Validate inputs (name length, content size, valid typeKey)
 * - Record audit trail (created_by / updated_by + timestamps)
 * - Return service-layer objects with boolean is_default via mapRowToTemplate
 */
export class PdfTemplateService {
  // ─── Read ─────────────────────────────────────────────────────────────────

  /**
   * Returns all templates with boolean is_default mapping.
   */
  static async getAll(): Promise<PdfTemplate[]> {
    const rows: PdfTemplateRow[] = await db
      .prepare('SELECT * FROM pdf_templates ORDER BY created_at DESC')
      .all();
    return rows.map(mapRowToTemplate);
  }

  /**
   * Returns a single template by ID.
   * Throws NotFoundError if the template does not exist.
   */
  static async getById(id: string): Promise<PdfTemplate> {
    const row: PdfTemplateRow | undefined = await db
      .prepare('SELECT * FROM pdf_templates WHERE id = ?::uuid')
      .get(id);
    if (!row) {
      throw new NotFoundError('Template not found');
    }
    return mapRowToTemplate(row);
  }

  /**
   * Returns the default approved template for a given type, or null.
   * Postcondition: at most one template (Approved + is_default=true) per type.
   */
  static async getActiveByType(typeKey: TemplateTypeKey): Promise<PdfTemplate | null> {
    const row: PdfTemplateRow | undefined = await db
      .prepare(
        `SELECT * FROM pdf_templates
         WHERE template_type_key = ? AND status = 'Approved' AND is_default = 1
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(typeKey);
    return row ? mapRowToTemplate(row) : null;
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  /**
   * Creates a new template.
   * - Validates name (≤200 chars), content (≤500KB), typeKey (valid)
   * - Assigns version = 1
   * - Records created_by / updated_by with current timestamp
   * - If is_default requested, ensures uniqueness per type
   */
  static async create(data: CreateTemplateDto, username: string): Promise<PdfTemplate> {
    // ── Validation ──
    if (!data.template_name || !data.template_type_key || !data.content) {
      throw new ValidationError('Missing required fields: template_name, template_type_key, and content are required');
    }

    if (data.template_name.length > MAX_NAME_LENGTH) {
      throw new ValidationError(
        `template_name exceeds maximum length of ${MAX_NAME_LENGTH} characters`
      );
    }

    const contentBytes = Buffer.byteLength(data.content, 'utf-8');
    if (contentBytes > MAX_CONTENT_BYTES) {
      throw new ValidationError(
        `content exceeds maximum size of 500 KB (received ${Math.round(contentBytes / 1024)} KB)`
      );
    }

    if (!isValidTemplateTypeKey(data.template_type_key)) {
      throw new ValidationError(
        `Invalid template_type_key: "${data.template_type_key}". Must be one of the defined TemplateTypeKey values.`
      );
    }

    // Only Approved templates can be set as default
    const status = data.status || 'Draft';
    const isDefault = data.is_default ? 1 : 0;

    if (isDefault === 1 && status !== 'Approved') {
      throw new ValidationError('Only Approved templates can be set as default');
    }

    return await db.transaction(async () => {
      // If marking as default, unset previous default for this type
      if (isDefault === 1) {
        await db
          .prepare(
            `UPDATE pdf_templates SET is_default = 0
             WHERE template_type_key = ? AND is_default = 1`
          )
          .run(data.template_type_key);
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const row: PdfTemplateRow | undefined = await db
        .prepare(
          `INSERT INTO pdf_templates
           (id, template_name, template_type_key, template_type, content, status, is_default, version, created_by, updated_by, created_at, updated_at)
           VALUES (?::uuid, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?::timestamp, ?::timestamp)
           RETURNING *`
        )
        .get(
          id,
          data.template_name,
          data.template_type_key,
          data.template_type_key, // template_type mirrors template_type_key for backwards compat
          data.content,
          status,
          isDefault,
          username,
          username,
          now,
          now
        );

      if (!row) {
        throw new Error('Failed to create template');
      }

      return mapRowToTemplate(row);
    });
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Updates an existing template.
   * - Version increments only when content changes
   * - Records updated_by + updated_at timestamp
   * - If is_default requested, ensures uniqueness per type
   */
  static async update(id: string, data: UpdateTemplateDto, username: string): Promise<PdfTemplate> {
    const existing = await this.getById(id);

    // ── Validation ──
    if (data.template_name !== undefined && data.template_name.length > MAX_NAME_LENGTH) {
      throw new ValidationError(
        `template_name exceeds maximum length of ${MAX_NAME_LENGTH} characters`
      );
    }

    if (data.content !== undefined) {
      const contentBytes = Buffer.byteLength(data.content, 'utf-8');
      if (contentBytes > MAX_CONTENT_BYTES) {
        throw new ValidationError(
          `content exceeds maximum size of 500 KB (received ${Math.round(contentBytes / 1024)} KB)`
        );
      }
    }

    // Determine if setting default
    const wantsDefault = data.is_default === true;
    const effectiveStatus = data.status ?? existing.status;

    if (wantsDefault && effectiveStatus !== 'Approved') {
      throw new ValidationError('Only Approved templates can be set as default');
    }

    // Version increments only on content change (Req 1.3)
    let newVersion = existing.version;
    if (data.content !== undefined && data.content !== existing.content) {
      newVersion = existing.version + 1;
    }

    return await db.transaction(async () => {
      // Ensure only one default per type (Req 2.1)
      if (wantsDefault) {
        await db
          .prepare(
            `UPDATE pdf_templates SET is_default = 0
             WHERE template_type_key = ? AND is_default = 1`
          )
          .run(existing.template_type_key);
      }

      const now = new Date().toISOString();

      const row: PdfTemplateRow | undefined = await db
        .prepare(
          `UPDATE pdf_templates
           SET template_name = COALESCE(?, template_name),
               content = COALESCE(?, content),
               status = COALESCE(?, status),
               is_default = COALESCE(?, is_default),
               version = ?,
               updated_by = ?,
               updated_at = ?::timestamp
           WHERE id = ?::uuid
           RETURNING *`
        )
        .get(
          data.template_name ?? null,
          data.content ?? null,
          data.status ?? null,
          data.is_default !== undefined ? (data.is_default ? 1 : 0) : null,
          newVersion,
          username,
          now,
          id
        );

      if (!row) {
        throw new NotFoundError('Template not found');
      }

      return mapRowToTemplate(row);
    });
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Deletes a template.
   * Rejects deletion of a default approved template (Req 1.6).
   */
  static async delete(id: string, _username: string): Promise<void> {
    const existing = await this.getById(id);

    // Protect default approved templates (Req 1.6)
    if (existing.is_default === true && existing.status === 'Approved') {
      throw new ValidationError(
        'Cannot delete the default approved template. Designate another template as default first.'
      );
    }

    await db.transaction(async () => {
      await db.prepare('DELETE FROM pdf_templates WHERE id = ?::uuid').run(id);
    });
  }
}
