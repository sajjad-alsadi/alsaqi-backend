/**
 * Endpoint contract interfaces for the Departments module.
 * Defines the request/response shapes for each route.
 */
import type { Department } from '../models';

export interface DepartmentsEndpoints {
  'GET /departments': {
    query: { page?: number; pageSize?: number; status?: string };
    response: Department[];
  };
  'GET /departments/:id': {
    params: { id: string };
    response: Department;
  };
  'POST /departments': {
    body: {
      name: string;
      name_ar: string;
      name_en?: string | null;
      entity_code: string;
      entity_type: string;
      parent_id?: string | null;
      manager_name?: string | null;
      level: number;
      status: string;
      display_order: number;
      description?: string;
      location?: string;
      cost_center_code?: string;
    };
    response: Department;
  };
  'PUT /departments/:id': {
    params: { id: string };
    body: Partial<{
      name: string;
      name_ar: string;
      name_en: string | null;
      entity_code: string;
      entity_type: string;
      parent_id: string | null;
      manager_name: string | null;
      level: number;
      status: string;
      display_order: number;
      description: string;
      location: string;
      cost_center_code: string;
    }>;
    response: Department;
  };
  'DELETE /departments/:id': {
    params: { id: string };
    response: { deleted: boolean };
  };
}
