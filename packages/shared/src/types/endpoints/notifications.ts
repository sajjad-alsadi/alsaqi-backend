/**
 * Endpoint contract interfaces for the Notifications module.
 * Defines the request/response shapes for each route.
 */
import type { Notification } from '../models';

export interface NotificationsEndpoints {
  /**
   * GET /notifications — paginated list of the current user's notifications.
   *
   * Repo convention: the `response` field declares the `data` payload that lives
   * INSIDE the Success_Envelope, NOT the full HTTP body and NOT a bare top-level
   * array. The actual HTTP response is:
   *
   *   {
   *     success: true,
   *     data: Notification[],
   *     meta: { requestId, timestamp, version, pagination }
   *   }
   *
   * Pagination metadata (page / pageSize / total / ...) lives in `meta.pagination`
   * at the envelope level — it is NOT part of this `response` array. The array
   * elements are NotificationFeedItem fields, which are a subset of the
   * `Notification` model, so `Notification` is used as the element type. This
   * mirrors the way other paginated list endpoints are typed, e.g.
   * `GET /risk-register` (response: RiskItem[]) and
   * `GET /recommendations` (response: Recommendation[]).
   */
  'GET /notifications': {
    query: { page?: number; pageSize?: number; status?: string };
    response: Notification[];
  };
  /**
   * GET /notifications/unread-count — number of unread notifications for the
   * current user. Matches `NotificationService.getUnreadCount`, which returns
   * `{ count }`. As with the other endpoints, `response` is the `data` payload
   * carried inside the Success_Envelope.
   */
  'GET /notifications/unread-count': {
    response: { count: number };
  };
  /**
   * PUT /notifications/:id/read — mark a single notification as read for the
   * current user. Retained for backward compatibility (not part of the bulk
   * contract); matches the backend route returning `{ success }`.
   */
  'PUT /notifications/:id/read': {
    params: { id: string };
    response: { success: boolean };
  };
  /**
   * DELETE /notifications/:id — dismiss (soft-hide) a notification for the
   * current user. Matches `NotificationService.dismiss`, which returns
   * `{ success }` (not a hard delete).
   */
  'DELETE /notifications/:id': {
    params: { id: string };
    response: { success: boolean };
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
