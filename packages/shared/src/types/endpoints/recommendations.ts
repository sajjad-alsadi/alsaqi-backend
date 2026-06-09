/**
 * Endpoint contract interfaces for the Recommendations module.
 * Defines the request/response shapes for each route.
 */
import type { Recommendation } from '../models';

export interface RecommendationsEndpoints {
  'GET /recommendations': {
    query: { page?: number; pageSize?: number; status?: string; finding_id?: number };
    response: Recommendation[];
  };
  'GET /recommendations/:id': {
    params: { id: string };
    response: Recommendation;
  };
  'POST /recommendations': {
    body: {
      finding_id: number;
      department: string;
      responsible: string;
      due_date: string;
      status?: 'Open' | 'In Progress' | 'Implemented' | 'Overdue';
      risk_level: 'Low' | 'Medium' | 'High';
    };
    response: Recommendation;
  };
  'PUT /recommendations/:id': {
    params: { id: string };
    body: Partial<{
      department: string;
      responsible: string;
      due_date: string;
      status: 'Open' | 'In Progress' | 'Implemented' | 'Overdue';
      risk_level: 'Low' | 'Medium' | 'High';
    }>;
    response: Recommendation;
  };
  'DELETE /recommendations/:id': {
    params: { id: string };
    response: { deleted: boolean };
  };
}
