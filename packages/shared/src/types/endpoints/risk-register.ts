/**
 * Endpoint contract interfaces for the Risk Register module.
 * Defines the request/response shapes for each route.
 */
import type { RiskItem } from '../models';

export interface RiskRegisterEndpoints {
  'GET /risk-register': {
    query: { page?: number; pageSize?: number; status?: string; rating?: string };
    response: RiskItem[];
  };
  'GET /risk-register/:id': {
    params: { id: string };
    response: RiskItem;
  };
  'POST /risk-register': {
    body: Omit<RiskItem, 'id'>;
    response: RiskItem;
  };
  'PUT /risk-register/:id': {
    params: { id: string };
    body: Partial<Omit<RiskItem, 'id'>>;
    response: RiskItem;
  };
  'DELETE /risk-register/:id': {
    params: { id: string };
    response: { deleted: boolean };
  };
}
