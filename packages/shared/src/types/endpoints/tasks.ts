/**
 * Endpoint contract interfaces for the Audit Tasks module.
 * Defines the request/response shapes for each route.
 */
import type { AuditTask } from '../models';
import type { CreateTaskInput, UpdateTaskInput } from '../../validators/tasks';

export interface TasksEndpoints {
  'GET /tasks': {
    query: { page?: number; pageSize?: number; status?: string; plan_id?: string };
    response: AuditTask[];
  };
  'GET /tasks/:id': {
    params: { id: string };
    response: AuditTask;
  };
  'POST /tasks': {
    body: CreateTaskInput;
    response: AuditTask;
  };
  'PUT /tasks/:id': {
    params: { id: string };
    body: UpdateTaskInput;
    response: AuditTask;
  };
  'DELETE /tasks/:id': {
    params: { id: string };
    response: { deleted: boolean };
  };
}
