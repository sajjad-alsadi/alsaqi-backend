import { describe, it, expect } from 'vitest';
import { CRUD_EXCLUDED_ROUTES, createCrudRoutes } from '../crudGenerator';

describe('CRUD Generator Exclusion', () => {
  it('CRUD_EXCLUDED_ROUTES is empty (dead calls removed entirely)', () => {
    // audit-tasks, audit-programs, recommendations, audit-findings, and
    // compliance-items were removed entirely from the CRUD generator.
    // Their generateRoutes calls no longer exist, so the exclusion array
    // is now empty — the guard is kept for future use but has no entries.
    expect(CRUD_EXCLUDED_ROUTES).toHaveLength(0);
  });

  it('does not generate routes for removed tables', () => {
    // Verify that the ALLOWED_TABLES no longer contains the removed tables
    // by checking that the router created by createCrudRoutes does not
    // register routes for them. We do this indirectly: if we attempt to
    // call createCrudRoutes it should not crash and should not include
    // the removed route names in its route stack.
    const mockAuth = (_req: any, _res: any, next: any) => next();
    const mockPerm = () => (_req: any, _res: any, next: any) => next();
    const mockLogError = async () => {};
    const mockNotification = async () => true;
    const mockSaveFile = async () => '/uploads/test.txt';

    const router = createCrudRoutes(
      {}, // db stub
      mockAuth,
      mockPerm,
      mockLogError,
      mockNotification,
      mockSaveFile
    );

    // Extract registered route paths from the router stack
    const registeredPaths = router.stack
      .filter((layer: any) => layer.route)
      .map((layer: any) => layer.route.path);

    // None of the removed routes should be present
    expect(registeredPaths).not.toContain('/audit-tasks');
    expect(registeredPaths).not.toContain('/audit-programs');
    expect(registeredPaths).not.toContain('/audit-findings');
    expect(registeredPaths).not.toContain('/recommendations');
    expect(registeredPaths).not.toContain('/compliance-items');

    // Remaining routes should still be present
    expect(registeredPaths).toContain('/audit-plans');
    expect(registeredPaths).toContain('/audit-procedures');
    expect(registeredPaths).toContain('/risk-register');
  });
});
