/**
 * Endpoint contract interfaces for the Findings module.
 * Defines the request/response shapes for each route.
 */
import type { AuditFinding } from '../models';
import type { CreateFindingInput, UpdateFindingInput } from '../../validators/findings';

export interface FindingsEndpoints {
  'GET /findings': {
    query: { page?: number; pageSize?: number; status?: string };
    response: AuditFinding[];
  };
  'POST /findings': {
    body: CreateFindingInput;
    response: AuditFinding;
  };
  'PUT /findings/:id': {
    params: { id: string };
    body: UpdateFindingInput;
    response: AuditFinding;
  };
  'DELETE /findings/:id': {
    params: { id: string };
    response: { deleted: boolean };
  };
}
