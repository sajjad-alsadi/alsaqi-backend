import express from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';
import { BulkOperationsService, BulkOperation } from '../services/BulkOperationsService';
import { AuthenticatedRequest } from '../types';
import { MODULES, PERMISSIONS } from '../permissions';

/**
 * Maps each bulk resource route name to the permission module that governs it,
 * so the bulk endpoint enforces the same per-resource authorization as the
 * dedicated CRUD routes (Finding 1.3 → 2.3, 1.6 → 2.6).
 */
const BULK_RESOURCE_MODULES: Record<string, string> = {
  'audit-plans': MODULES.AUDIT_PLANS,
  'audit-tasks': MODULES.AUDIT_TASKS,
  'audit-programs': MODULES.AUDIT_PROGRAM_LIBRARY,
  'audit-procedures': MODULES.AUDIT_TASKS,
  'audit-evidence': MODULES.AUDIT_EVIDENCE,
  'risk-register': MODULES.RISK_REGISTER,
  'fraud-log': MODULES.INTEGRITY_MANAGEMENT,
  'central-bank-instructions': MODULES.COMPLIANCE_MATRIX,
  'law-bank': MODULES.COMPLIANCE_MATRIX,
  'audit-reports': MODULES.REPORTS,
  'audit-findings': MODULES.AUDIT_FINDINGS,
  'recommendations': MODULES.RECOMMENDATIONS,
  'compliance-items': MODULES.COMPLIANCE_MATRIX,
};

/** Maps each bulk operation to the permission action it requires. */
const BULK_OPERATION_ACTIONS: Record<string, string> = {
  create: PERMISSIONS.CREATE,
  update: PERMISSIONS.EDIT,
  delete: PERMISSIONS.DELETE,
};

/**
 * Creates the bulk operations router.
 *
 * Endpoint: POST /api/v1/bulk/:resource
 * Body: { operation: 'create' | 'update' | 'delete', items: [...] }
 *
 * Requires `authenticate` AND a per-resource/action `checkPermission`, so a
 * logged-in user cannot mutate sensitive tables without the matching module
 * permission (Finding 1.3 → 2.3). Validates all items before processing;
 * rejects entire batch on validation failure. Processes all valid items in a
 * single transaction; rolls back on any processing failure. Returns response
 * with processed count, success count, and per-item status.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6
 */
export const createBulkRoutes = (authenticate: any, checkPermission: any) => {
  const router = express.Router();

  const VALID_OPERATIONS: BulkOperation[] = ['create', 'update', 'delete'];

  /**
   * Resolves the resource + operation to a module/action and delegates to the
   * shared `checkPermission` middleware. When the resource or operation is not
   * recognized, it defers to the handler so the canonical ValidationError (and
   * its error shape) is preserved.
   */
  const enforceBulkPermission = (req: any, res: any, next: any) => {
    const resource = String(req.params.resource);
    const operation = req.body?.operation;
    const moduleName = BULK_RESOURCE_MODULES[resource];
    const action = BULK_OPERATION_ACTIONS[operation];

    if (!moduleName || !action) {
      // Unknown resource/operation — let the handler raise the canonical
      // ValidationError rather than authorizing against an unknown module.
      return next();
    }

    return checkPermission(moduleName, action)(req, res, next);
  };

  router.post('/:resource', authenticate, enforceBulkPermission, asyncHandler(async (req, res) => {
    const typedReq = req as unknown as AuthenticatedRequest;
    const resource = String(typedReq.params.resource);
    const { operation, items } = typedReq.body;

    // Validate operation type
    if (!operation || !VALID_OPERATIONS.includes(operation)) {
      throw new ValidationError(
        `Invalid operation. Must be one of: ${VALID_OPERATIONS.join(', ')}`,
        { field: 'operation', received: operation }
      );
    }

    // Validate items is present and is an array
    if (!items || !Array.isArray(items)) {
      throw new ValidationError(
        'Request body must contain an "items" array',
        { field: 'items' }
      );
    }

    const username = typedReq.user?.username || 'unknown';

    const result = await BulkOperationsService.execute(
      resource,
      operation as BulkOperation,
      items,
      username
    );

    res.json(result);
  }));

  return router;
};
