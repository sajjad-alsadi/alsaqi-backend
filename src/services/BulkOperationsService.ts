import { db } from '../db/index';
import { BaseService } from './BaseService';
import { ValidationError } from '../utils/errors';

/**
 * Supported bulk operation types.
 */
export type BulkOperation = 'create' | 'update' | 'delete';

/**
 * A single item in a bulk operation request.
 */
export interface BulkItem {
  id?: string | number;
  [key: string]: any;
}

/**
 * Per-item result in the bulk operation response.
 */
export interface BulkItemResult {
  index: number;
  id?: string | number;
  success: boolean;
  error?: string;
}

/**
 * Validation error for a single item in the batch.
 */
export interface BulkItemValidationError {
  index: number;
  errors: string[];
}

/**
 * Response from a successful bulk operation.
 */
export interface BulkOperationResponse {
  processed: number;
  success: number;
  failed: number;
  details: BulkItemResult[];
}

/**
 * Allowed resource tables for bulk operations.
 * Maps route resource names to database table names.
 */
export const BULK_ALLOWED_RESOURCES: Record<string, string> = {
  'audit-plans': 'audit_plans',
  'audit-tasks': 'audit_tasks',
  'audit-programs': 'audit_programs',
  'audit-procedures': 'audit_procedures',
  'audit-evidence': 'audit_evidence',
  'risk-register': 'risk_register',
  'fraud-log': 'fraud_log',
  'central-bank-instructions': 'central_bank_instructions',
  'law-bank': 'law_bank',
  'audit-reports': 'audit_reports',
  'audit-findings': 'audit_findings',
  'recommendations': 'recommendations',
  'compliance-items': 'compliance_items',
};

/** Minimum batch size */
export const MIN_BATCH_SIZE = 1;

/** Maximum batch size */
export const MAX_BATCH_SIZE = 100;

/**
 * Bulk Operations Service for the AL-SAQI system.
 *
 * Processes multiple create/update/delete operations in a single transactional request.
 * Validates all items before processing; rejects entire batch on validation failure.
 * Processes all valid items in a single transaction; rolls back on any processing failure.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6
 */
export class BulkOperationsService extends BaseService {
  /**
   * Validates the batch size is within the allowed range (1-100).
   *
   * @param items - The items array to validate
   * @throws ValidationError if batch size is outside the allowed range
   */
  static validateBatchSize(items: any[]): void {
    if (!Array.isArray(items) || items.length < MIN_BATCH_SIZE || items.length > MAX_BATCH_SIZE) {
      throw new ValidationError(
        `Batch size must be between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE} items`,
        { min: MIN_BATCH_SIZE, max: MAX_BATCH_SIZE, received: Array.isArray(items) ? items.length : 0 }
      );
    }
  }

  /**
   * Resolves a resource route name to a database table name.
   *
   * @param resource - The resource route name (e.g., 'audit-plans')
   * @returns The database table name
   * @throws ValidationError if the resource is not allowed
   */
  static resolveTable(resource: string): string {
    const tableName = BULK_ALLOWED_RESOURCES[resource];
    if (!tableName) {
      throw new ValidationError(
        `Resource '${resource}' is not supported for bulk operations`,
        { allowedResources: Object.keys(BULK_ALLOWED_RESOURCES) }
      );
    }
    return tableName;
  }

  /**
   * Validates all items in the batch before processing.
   * Returns per-item validation errors if any item fails.
   *
   * @param operation - The bulk operation type
   * @param items - The items to validate
   * @param tableName - The target database table
   * @returns Array of validation errors (empty if all valid)
   */
  static validateItems(
    operation: BulkOperation,
    items: BulkItem[],
    tableName: string
  ): BulkItemValidationError[] {
    const errors: BulkItemValidationError[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemErrors: string[] = [];

      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        itemErrors.push('Item must be a non-null object');
        errors.push({ index: i, errors: itemErrors });
        continue;
      }

      switch (operation) {
        case 'create': {
          // For create, item must have at least one field (excluding id)
          const createFields = Object.keys(item).filter(k => k !== 'id');
          if (createFields.length === 0) {
            itemErrors.push('Item must have at least one field for creation');
          }
          break;
        }

        case 'update': {
          // For update, item must have an id and at least one other field
          if (!item.id) {
            itemErrors.push('Item must have an "id" field for update operations');
          }
          const updateFields = Object.keys(item).filter(k => k !== 'id');
          if (updateFields.length === 0) {
            itemErrors.push('Item must have at least one field to update besides "id"');
          }
          break;
        }

        case 'delete':
          // For delete, item must have an id
          if (!item.id) {
            itemErrors.push('Item must have an "id" field for delete operations');
          }
          break;

        default:
          itemErrors.push(`Unsupported operation: ${operation}`);
      }

      if (itemErrors.length > 0) {
        errors.push({ index: i, errors: itemErrors });
      }
    }

    return errors;
  }

  /**
   * Executes a bulk operation within a single database transaction.
   * All items are processed; if any fails, the entire transaction is rolled back.
   *
   * @param resource - The resource route name
   * @param operation - The bulk operation type
   * @param items - The items to process
   * @param username - The username performing the operation (for audit logging)
   * @returns The bulk operation response with per-item status
   * @throws ValidationError if batch size is invalid, resource is unsupported, or items fail validation
   *
   * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6
   */
  static async execute(
    resource: string,
    operation: BulkOperation,
    items: BulkItem[],
    username: string
  ): Promise<BulkOperationResponse> {
    // Validate batch size (Requirement 16.3)
    this.validateBatchSize(items);

    // Resolve resource to table name
    const tableName = this.resolveTable(resource);

    // Validate all items before processing (Requirement 16.1, 16.2)
    const validationErrors = this.validateItems(operation, items, tableName);
    if (validationErrors.length > 0) {
      throw new ValidationError(
        'Batch validation failed: one or more items have errors',
        { items: validationErrors }
      );
    }

    // Process all items in a single transaction (Requirement 16.1, 16.4)
    const details: BulkItemResult[] = await db.transaction(async () => {
      const results: BulkItemResult[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];

        try {
          switch (operation) {
            case 'create': {
              const result = await this.processCreate(tableName, item);
              results.push({ index: i, id: result.id, success: true });
              break;
            }
            case 'update': {
              const { id, ...data } = item;
              await this.processUpdate(tableName, id!, data);
              results.push({ index: i, id: id!, success: true });
              break;
            }
            case 'delete': {
              await this.processDelete(tableName, item.id!);
              results.push({ index: i, id: item.id!, success: true });
              break;
            }
          }
        } catch (error: any) {
          // If any item fails during processing, throw to trigger rollback (Requirement 16.4)
          throw new Error(
            `Processing failed at item index ${i}: ${error.message || 'Unknown error'}`
          );
        }
      }

      return results;
    });

    // Record single audit log entry for the bulk operation (Requirement 16.6)
    await this.logAudit(
      username,
      `Bulk ${operation}`,
      resource,
      `Bulk ${operation} on ${tableName}: ${items.length} items processed`
    );

    // Return response (Requirement 16.5)
    const successCount = details.filter(d => d.success).length;
    return {
      processed: details.length,
      success: successCount,
      failed: details.length - successCount,
      details,
    };
  }

  /**
   * Processes a single create operation within the transaction.
   */
  private static async processCreate(tableName: string, data: BulkItem): Promise<{ id: string | number }> {
    const body = this.sanitizeBody({ ...data });
    // Remove system fields
    const restrictedColumns = ['id', 'created_at', 'updated_at'];
    restrictedColumns.forEach(col => {
      if (col in body) delete body[col];
    });

    const keys = Object.keys(body).map(k => this.db.validateIdentifier(k));
    const values = Object.values(body);

    if (keys.length === 0) {
      throw new ValidationError('No data provided for creation');
    }

    const placeholders = keys.map(() => '?').join(',');
    const validatedTable = this.db.validateIdentifier(tableName);
    const info = await this.db.prepare(
      `INSERT INTO ${validatedTable} (${keys.join(',')}) VALUES (${placeholders})`
    ).run(...values) as any;

    return { id: info.lastInsertRowid };
  }

  /**
   * Processes a single update operation within the transaction.
   */
  private static async processUpdate(tableName: string, id: string | number, data: Record<string, any>): Promise<void> {
    const body = this.sanitizeBody({ ...data });
    // Remove immutable fields
    const immutableFields = [
      'id', 'created_at', 'updated_at',
      'plan_code', 'program_code', 'task_number', 'finding_number',
      'rec_number', 'risk_id', 'employee_id'
    ];
    immutableFields.forEach(col => delete body[col]);

    const keys = Object.keys(body).map(k => this.db.validateIdentifier(k));
    const values = Object.values(body);

    if (keys.length === 0) {
      throw new ValidationError('No data provided for update');
    }

    const setClause = keys.map(k => `${k} = ?`).join(',');
    const validatedTable = this.db.validateIdentifier(tableName);
    const result = await this.db.prepare(
      `UPDATE ${validatedTable} SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL RETURNING id`
    ).get(...values, id);

    if (!result) {
      throw new Error(`Record with ID ${id} not found or is deleted`);
    }
  }

  /**
   * Processes a single delete operation within the transaction.
   * Uses soft delete (sets deleted_at) to be consistent with the system's soft delete approach.
   */
  private static async processDelete(tableName: string, id: string | number): Promise<void> {
    const validatedTable = this.db.validateIdentifier(tableName);
    const now = new Date().toISOString();

    const result = await this.db.prepare(
      `UPDATE ${validatedTable} SET deleted_at = ?::timestamptz WHERE id = ? AND deleted_at IS NULL RETURNING id`
    ).get(now, id);

    if (!result) {
      throw new Error(`Record with ID ${id} not found or already deleted`);
    }
  }
}
