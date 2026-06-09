/**
 * Endpoint contract interfaces for the Notifications module.
 * Defines the request/response shapes for each route.
 */
import type { Notification } from '../models';

export interface NotificationsEndpoints {
  'GET /notifications': {
    query: { page?: number; pageSize?: number; status?: string };
    response: Notification[];
  };
  'PUT /notifications/mark-read': {
    body: { notification_ids: Array<string | number> };
    response: { updated: number };
  };
  'PUT /notifications/mark-all-read': {
    body: undefined;
    response: { updated: number };
  };
}
