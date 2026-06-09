import { db } from '../db/index';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { BaseService } from './BaseService';
import { computePaginationMeta } from '../utils/paginationService';
import type { PaginationMeta } from '@alsaqi/shared';

/**
 * Options for performing a soft delete operation.
 */
export interface SoftDeleteOptions {
  tableName: string;
  id: string | number;
  deletedBy: string;
  cascade?: { table: string; foreignKey: string }[];
}

/**
 * Result of a paginated soft-deleted records query.
 */
export interface SoftDeletedListResult {
  data: any[];
  pagination: PaginationMeta;
}

/**
 * Unified Soft Delete Service for the AL-SAQI system.
 *
 * Provides consistent soft delete, restore, permanent delete, and listing
 * of soft-deleted records across all entity tables.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9
 */
export class SoftDeleteService extends BaseService {
  /**
   * Soft deletes a record by setting deleted_at and deleted_by.
   * Cascades soft delete to dependent records within a single transaction.
   * Records an audit log entry for the operation.
   *
   * @param options - The soft delete options including table, id, user, and cascade config
   * @throws NotFoundError if the record does not exist or is already soft-deleted
   *
   * Requirements: 8.1, 8.4, 8.7, 8.9
   */
  static async softDelete(options: SoftDeleteOptions): Promise<void> {
    const { tableName, id, deletedBy, cascade } = options;
    const validatedTable = this.db.validateIdentifier(tableName);
    const now = new Date().toISOString();

    await this.db.transaction(async () => {
      // Mark main record as deleted
      const result = await this.db.prepare(
        `UPDATE ${validatedTable} SET deleted_at = ?::timestamptz, deleted_by = ?::uuid WHERE id = ? AND deleted_at IS NULL RETURNING id`
      ).get(now, deletedBy, id);

      if (!result) {
        throw new NotFoundError(
          `Record not found or not eligible for this operation`
        );
      }

      // Cascade soft delete to related records
      if (cascade && cascade.length > 0) {
        for (const rel of cascade) {
          const relTable = this.db.validateIdentifier(rel.table);
          const relFK = this.db.validateIdentifier(rel.foreignKey);
          await this.db.prepare(
            `UPDATE ${relTable} SET deleted_at = ?::timestamptz, deleted_by = ?::uuid WHERE ${relFK} = ? AND deleted_at IS NULL`
          ).run(now, deletedBy, id);
        }
      }

      // Audit log
      await this.logAudit(
        deletedBy,
        'Soft Delete',
        tableName,
        `Soft deleted record ID: ${id}`
      );
    });
  }

  /**
   * Restores a soft-deleted record by clearing deleted_at and deleted_by.
   * Records an audit log entry for the operation.
   *
   * @param tableName - The table containing the record
   * @param id - The record ID to restore
   * @param restoredBy - The username performing the restore
   * @throws NotFoundError if the record does not exist or is not soft-deleted
   *
   * Requirements: 8.3, 8.7, 8.9
   */
  static async restore(tableName: string, id: string | number, restoredBy: string): Promise<void> {
    const validatedTable = this.db.validateIdentifier(tableName);

    const result = await this.db.prepare(
      `UPDATE ${validatedTable} SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL RETURNING id`
    ).get(id);

    if (!result) {
      throw new NotFoundError(
        `Record not found or not eligible for this operation`
      );
    }

    // Audit log
    await this.logAudit(
      restoredBy,
      'Restore',
      tableName,
      `Restored record ID: ${id}`
    );
  }

  /**
   * Permanently deletes a record from the database.
   * Requires administrator-level permissions.
   * Records an audit log entry for the operation.
   *
   * @param tableName - The table containing the record
   * @param id - The record ID to permanently delete
   * @param deletedBy - The username performing the delete
   * @param isAdmin - Whether the user has administrator-level permissions
   * @throws ForbiddenError if the user does not have admin permissions
   * @throws NotFoundError if the record does not exist
   *
   * Requirements: 8.5, 8.6, 8.7, 8.9
   */
  static async permanentDelete(
    tableName: string,
    id: string | number,
    deletedBy: string,
    isAdmin: boolean
  ): Promise<void> {
    if (!isAdmin) {
      throw new ForbiddenError('Forbidden');
    }

    const validatedTable = this.db.validateIdentifier(tableName);

    // Check if record exists
    const existing = await this.db.prepare(
      `SELECT id FROM ${validatedTable} WHERE id = ?`
    ).get(id);

    if (!existing) {
      throw new NotFoundError(
        `Record not found or not eligible for this operation`
      );
    }

    await this.db.prepare(
      `DELETE FROM ${validatedTable} WHERE id = ?`
    ).run(id);

    // Audit log
    await this.logAudit(
      deletedBy,
      'Permanent Delete',
      tableName,
      `Permanently deleted record ID: ${id}`
    );
  }

  /**
   * Returns a paginated list of soft-deleted records for a given table.
   *
   * @param tableName - The table to query
   * @param page - The page number (1-based)
   * @param pageSize - The number of items per page
   * @returns Paginated list of soft-deleted records
   *
   * Requirements: 8.8
   */
  static async getDeleted(
    tableName: string,
    page = 1,
    pageSize = 20
  ): Promise<SoftDeletedListResult> {
    const validatedTable = this.db.validateIdentifier(tableName);
    const offset = (page - 1) * pageSize;

    const countRes = await this.db.prepare(
      `SELECT COUNT(*) as total FROM ${validatedTable} WHERE deleted_at IS NOT NULL`
    ).get();
    const total = countRes?.total || 0;

    const data = await this.db.prepare(
      `SELECT * FROM ${validatedTable} WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?`
    ).all(pageSize, offset);

    return {
      data,
      pagination: computePaginationMeta(page, pageSize, total),
    };
  }
}
