import express from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';
import { BulkOperationsService, BulkOperation } from '../services/BulkOperationsService';
import { AuthenticatedRequest } from '../types';

/**
 * Creates the bulk operations router.
 *
 * Endpoint: POST /api/v1/bulk/:resource
 * Body: { operation: 'create' | 'update' | 'delete', items: [...] }
 *
 * Validates all items before processing; rejects entire batch on validation failure.
 * Processes all valid items in a single transaction; rolls back on any processing failure.
 * Returns response with processed count, success count, and per-item status.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6
 */
export const createBulkRoutes = (authenticate: any) => {
  const router = express.Router();

  const VALID_OPERATIONS: BulkOperation[] = ['create', 'update', 'delete'];

  router.post('/:resource', authenticate, asyncHandler(async (req, res) => {
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
