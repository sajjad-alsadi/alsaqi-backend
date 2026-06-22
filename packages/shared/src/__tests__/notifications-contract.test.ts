/**
 * Compile-time type-assertion test for the Notifications endpoint contract.
 *
 * Mirrors the conditional-type-assertion pattern established in
 * `fix-be-5-imports.test.ts`: each `const ... extends ... ? true : false = true`
 * assignment is a compile-time assertion. If the contract shape drifts (a route
 * is renamed/removed, or a `params`/`response` shape changes), `tsc` (and the
 * Vitest transform) fails to compile this file, which fails the test run.
 *
 * The fact that this file compiles is itself the verification that the shared
 * package type-checks for the notifications contract (R11.5 / R12.6).
 *
 * Requirements:
 *   7.10  - New notification routes (unread-count, :id/read, DELETE /:id) are
 *           declared on the contract with the correct params/response shapes.
 *   7.11  - `GET /notifications` response is typed as `Notification[]`.
 *   11.1  - List endpoint response element type is the `Notification` model.
 *   12.1  - `GET /notifications/unread-count` response extends `{ count: number }`.
 *   12.2  - `PUT /notifications/:id/read` has `params: { id: string }` and
 *           response extends `{ success: boolean }`.
 *   12.3  - `DELETE /notifications/:id` has `params: { id: string }` and
 *           response extends `{ success: boolean }`.
 *
 * Spec: .kiro/specs/backend-api-contract-alignment (task 9.3)
 */
import { describe, it, expect } from 'vitest';

// ── Type-level imports ──────────────────────────────────────────────────────
// Both `NotificationsEndpoints` (an interface) and `Notification` (the model)
// are erased at runtime; importing them by name from the package root acts as
// a compile-time assertion that they are exported. A rename/removal breaks
// compilation and fails this file.
import type { NotificationsEndpoints, Notification } from '../index';

describe('Notifications endpoint contract (compile-time type assertions)', () => {
  describe('GET /notifications (R7.11, R11.1)', () => {
    it('response extends Notification[]', () => {
      type GetList = NotificationsEndpoints['GET /notifications'];

      const responseIsNotificationArray: GetList['response'] extends Notification[]
        ? true
        : false = true;

      expect(responseIsNotificationArray).toBe(true);
    });
  });

  describe('GET /notifications/unread-count (R7.10, R12.1)', () => {
    it('response extends { count: number }', () => {
      type UnreadCount = NotificationsEndpoints['GET /notifications/unread-count'];

      const responseHasCount: UnreadCount['response'] extends { count: number }
        ? true
        : false = true;

      expect(responseHasCount).toBe(true);
    });
  });

  describe('PUT /notifications/:id/read (R7.10, R12.2)', () => {
    it('has params: { id: string } and response extends { success: boolean }', () => {
      type MarkRead = NotificationsEndpoints['PUT /notifications/:id/read'];

      const paramsHaveStringId: MarkRead['params'] extends { id: string }
        ? true
        : false = true;
      const responseHasSuccess: MarkRead['response'] extends { success: boolean }
        ? true
        : false = true;

      expect(paramsHaveStringId).toBe(true);
      expect(responseHasSuccess).toBe(true);
    });
  });

  describe('DELETE /notifications/:id (R7.10, R12.3)', () => {
    it('has params: { id: string } and response extends { success: boolean }', () => {
      type Dismiss = NotificationsEndpoints['DELETE /notifications/:id'];

      const paramsHaveStringId: Dismiss['params'] extends { id: string }
        ? true
        : false = true;
      const responseHasSuccess: Dismiss['response'] extends { success: boolean }
        ? true
        : false = true;

      expect(paramsHaveStringId).toBe(true);
      expect(responseHasSuccess).toBe(true);
    });
  });
});
