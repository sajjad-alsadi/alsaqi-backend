/**
 * Endpoint contract interfaces for the Audit Plans module.
 * Defines the request/response shapes for each route.
 */
import type { AuditPlan } from '../models';
import type { CreateAuditPlanInput, UpdateAuditPlanInput } from '../../validators/audit-plans';

export interface AuditPlansEndpoints {
  'GET /audit-plans': {
    query: { page?: number; pageSize?: number; status?: string; department?: string };
    response: AuditPlan[];
  };
  'GET /audit-plans/:id': {
    params: { id: string };
    response: AuditPlan;
  };
  'POST /audit-plans': {
    body: CreateAuditPlanInput;
    response: AuditPlan;
  };
  'PUT /audit-plans/:id': {
    params: { id: string };
    body: UpdateAuditPlanInput;
    response: AuditPlan;
  };
  'DELETE /audit-plans/:id': {
    params: { id: string };
    response: { deleted: boolean };
  };
}
