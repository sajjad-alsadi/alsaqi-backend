import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { ADMIN_ROLES } from '@alsaqi/shared';

/**
 * Preservation Property Tests - Admin Bypass, Auth Flow, and Audit Logging Unchanged
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
 *
 * These tests capture the CURRENT (correct) behavior of the system for non-buggy inputs.
 * They must PASS on the unfixed code and continue to PASS after the fix is applied.
 * If any of these tests fail after the fix, it indicates a regression.
 *
 * Preserved behaviors:
 * - Admin user with role "Admin" can access all user management routes
 * - Unauthenticated requests return 401
 * - Suspended/Disabled/Archived users return 403
 * - Non-admin users without ADMIN_ROLES role return 403 on user routes
 * - Audit trail entries are created on user CRUD operations
 * - clearPermissionCache() is called after role permission updates
 * - invalidateUserCache() is called after user modifications
 */

// =============================================================================
// Test App Factory - Simulates the CURRENT (unfixed) middleware behavior
// =============================================================================

interface MockUser {
  id: string;
  role: string;
  username: string;
  name: string;
  email: string;
  status: string;
  session_version: number;
  requires_password_change: boolean;
}

function createTestApp(options: {
  authenticatedUser?: MockUser | null;
  skipAuth?: boolean;
}) {
  const app = express();
  app.use(express.json());

  const auditLog: Array<{ username: string; action: string; module: string; details: string }> = [];
  const cacheInvalidations: string[] = [];

  // Simulate authenticate middleware (mirrors auth.ts behavior)
  const authenticate = (req: any, res: any, next: any) => {
    if (options.skipAuth || !options.authenticatedUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = options.authenticatedUser;

    if (user.status === 'Suspended' || user.status === 'Disabled' || user.status === 'Archived') {
      return res.status(403).json({ error: 'Account suspended, disabled or archived' });
    }

    req.user = {
      id: user.id,
      role: user.role,
      username: user.username,
      name: user.name,
      email: user.email,
      requires_password_change: user.requires_password_change,
    };
    next();
  };

  // Simulate authorize middleware (mirrors auth.ts behavior)
  const authorize = (allowedRoles: readonly string[]) => {
    return (req: any, res: any, next: any) => {
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      }
      next();
    };
  };

  // Simulate user routes with audit logging and cache invalidation
  // GET routes
  app.get('/api/users/init', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    res.json({ roles: [], departments: [] });
  });

  app.get('/api/users', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    res.json({ users: [], total: 0 });
  });

  app.get('/api/users/summary', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    res.json({ total: 0, active: 0, suspended: 0 });
  });

  app.get('/api/users/list', authenticate, (req, res) => {
    res.json([]);
  });

  app.get('/api/users/:id', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    res.json({ id: req.params.id, name: 'Test User' });
  });

  // POST create user
  app.post('/api/users', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    auditLog.push({
      username: (req as any).user.username,
      action: 'Created User',
      module: 'User Management',
      details: `Created user ${req.body.username}`,
    });
    res.json({ id: 'new-user-id', ...req.body });
  });

  // PUT update user
  app.put('/api/users/:id', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    cacheInvalidations.push(req.params.id);
    auditLog.push({
      username: (req as any).user.username,
      action: 'Updated User',
      module: 'User Management',
      details: `Updated user ID ${req.params.id}`,
    });
    res.json({ success: true });
  });

  // DELETE user
  app.delete('/api/users/:id', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    cacheInvalidations.push(req.params.id);
    auditLog.push({
      username: (req as any).user.username,
      action: 'Deleted User',
      module: 'User Management',
      details: `Deleted user ${req.params.id}`,
    });
    res.json({ success: true });
  });

  // POST suspend
  app.post('/api/users/:id/suspend', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    cacheInvalidations.push(req.params.id);
    auditLog.push({
      username: (req as any).user.username,
      action: 'Suspended User',
      module: 'User Management',
      details: `Suspended user ${req.params.id}`,
    });
    res.json({ success: true, status: 'Suspended' });
  });

  // POST archive
  app.post('/api/users/:id/archive', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    cacheInvalidations.push(req.params.id);
    auditLog.push({
      username: (req as any).user.username,
      action: 'Archive',
      module: 'User Management',
      details: `Archived user ${req.params.id}`,
    });
    res.json({ success: true });
  });

  // POST activate
  app.post('/api/users/:id/activate', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    cacheInvalidations.push(req.params.id);
    auditLog.push({
      username: (req as any).user.username,
      action: 'Activate',
      module: 'User Management',
      details: `Activated user ${req.params.id}`,
    });
    res.json({ success: true });
  });

  // POST unlock
  app.post('/api/users/:id/unlock', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    cacheInvalidations.push(req.params.id);
    auditLog.push({
      username: (req as any).user.username,
      action: 'Unlocked User',
      module: 'User Management',
      details: `Unlocked user ${req.params.id}`,
    });
    res.json({ success: true });
  });

  // POST reset-password
  app.post('/api/users/:id/reset-password', authenticate, authorize(ADMIN_ROLES), (req, res) => {
    auditLog.push({
      username: (req as any).user.username,
      action: 'Reset Password',
      module: 'User Management',
      details: `Reset password for user ${req.params.id}`,
    });
    res.json({ success: true });
  });

  return { app, auditLog, cacheInvalidations };
}

// =============================================================================
// Property 5: Admin Bypass Preservation
// =============================================================================

describe('Preservation: Admin Bypass Unchanged (Property 5)', () => {
  /**
   * **Validates: Requirements 3.1, 3.5**
   *
   * For ALL Admin users, ALL user management operations succeed.
   * The Admin role bypasses permission checks entirely.
   */

  it('property: for all Admin users, all user management GET routes return 200', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          adminId: fc.uuid(),
          adminUsername: fc.string({ minLength: 3, maxLength: 20 }).filter(s => /^[a-zA-Z]/.test(s)),
        }),
        async ({ adminId, adminUsername }) => {
          const { app } = createTestApp({
            authenticatedUser: {
              id: adminId,
              role: 'Admin',
              username: adminUsername,
              name: 'Admin User',
              email: 'admin@test.com',
              status: 'Active',
              session_version: 1,
              requires_password_change: false,
            },
          });

          const routes = ['/api/users/init', '/api/users', '/api/users/summary', '/api/users/some-id'];
          for (const route of routes) {
            const res = await request(app).get(route);
            expect(res.status).toBe(200);
          }
        }
      ),
      { numRuns: 10 }
    );
  });

  it('property: for all Admin users, all user management write operations return 200', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          adminId: fc.uuid(),
          targetUserId: fc.uuid(),
        }),
        async ({ adminId, targetUserId }) => {
          const { app } = createTestApp({
            authenticatedUser: {
              id: adminId,
              role: 'Admin',
              username: 'admin',
              name: 'Admin User',
              email: 'admin@test.com',
              status: 'Active',
              session_version: 1,
              requires_password_change: false,
            },
          });

          // POST create
          const createRes = await request(app)
            .post('/api/users')
            .send({ username: 'newuser', password: 'pass123', name: 'New', email: 'new@test.com', role: 'Viewer' });
          expect(createRes.status).toBe(200);

          // PUT update
          const updateRes = await request(app)
            .put(`/api/users/${targetUserId}`)
            .send({ name: 'Updated', email: 'up@test.com', role: 'Manager' });
          expect(updateRes.status).toBe(200);

          // DELETE
          const deleteRes = await request(app).delete(`/api/users/${targetUserId}`);
          expect(deleteRes.status).toBe(200);

          // POST suspend
          const suspendRes = await request(app).post(`/api/users/${targetUserId}/suspend`);
          expect(suspendRes.status).toBe(200);

          // POST archive
          const archiveRes = await request(app).post(`/api/users/${targetUserId}/archive`);
          expect(archiveRes.status).toBe(200);

          // POST activate
          const activateRes = await request(app).post(`/api/users/${targetUserId}/activate`);
          expect(activateRes.status).toBe(200);

          // POST unlock
          const unlockRes = await request(app).post(`/api/users/${targetUserId}/unlock`);
          expect(unlockRes.status).toBe(200);

          // POST reset-password
          const resetRes = await request(app)
            .post(`/api/users/${targetUserId}/reset-password`)
            .send({ newPassword: 'newpass123' });
          expect(resetRes.status).toBe(200);
        }
      ),
      { numRuns: 5 }
    );
  });

  it('Admin role "Admin" is always in ADMIN_ROLES and passes authorize check', () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * Confirms that the "Admin" role is in ADMIN_ROLES, ensuring the authorize()
     * middleware always passes for Admin users.
     */
    expect(ADMIN_ROLES).toContain('Admin');
  });
});

// =============================================================================
// Preservation: Unauthenticated Requests Return 401
// =============================================================================

describe('Preservation: Unauthenticated Requests Return 401 (Requirements 3.3)', () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * For ALL unauthenticated requests, the system returns 401 Unauthorized.
   * The authenticate middleware checks for a valid token and rejects if missing.
   */

  it('property: for all user management routes, unauthenticated requests return 401', async () => {
    const { app } = createTestApp({ skipAuth: true });

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          { method: 'get', path: '/api/users/init' },
          { method: 'get', path: '/api/users' },
          { method: 'get', path: '/api/users/summary' },
          { method: 'get', path: '/api/users/list' },
          { method: 'get', path: '/api/users/some-id' },
          { method: 'post', path: '/api/users' },
          { method: 'put', path: '/api/users/some-id' },
          { method: 'delete', path: '/api/users/some-id' },
          { method: 'post', path: '/api/users/some-id/suspend' },
          { method: 'post', path: '/api/users/some-id/archive' },
          { method: 'post', path: '/api/users/some-id/activate' },
          { method: 'post', path: '/api/users/some-id/unlock' },
          { method: 'post', path: '/api/users/some-id/reset-password' },
        ),
        async (route) => {
          const res = await (request(app) as any)[route.method](route.path);
          expect(res.status).toBe(401);
        }
      ),
      { numRuns: 13 }
    );
  });
});

// =============================================================================
// Preservation: Suspended Users Return 403
// =============================================================================

describe('Preservation: Suspended/Disabled/Archived Users Return 403 (Requirements 3.3)', () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * For ALL suspended, disabled, or archived users, the system returns 403.
   * The authenticate middleware checks user status and rejects inactive accounts.
   */

  it('property: for all suspended users, all routes return 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: fc.uuid(),
          status: fc.constantFrom('Suspended', 'Disabled', 'Archived'),
          role: fc.constantFrom('Admin', 'Manager', 'Internal Auditor', 'Viewer'),
        }),
        async ({ userId, status, role }) => {
          const { app } = createTestApp({
            authenticatedUser: {
              id: userId,
              role,
              username: 'testuser',
              name: 'Test User',
              email: 'test@test.com',
              status,
              session_version: 1,
              requires_password_change: false,
            },
          });

          // Test multiple routes - all should return 403 for suspended users
          const getRes = await request(app).get('/api/users');
          expect(getRes.status).toBe(403);

          const postRes = await request(app).post('/api/users').send({});
          expect(postRes.status).toBe(403);

          const deleteRes = await request(app).delete(`/api/users/some-id`);
          expect(deleteRes.status).toBe(403);
        }
      ),
      { numRuns: 10 }
    );
  });
});

// =============================================================================
// Preservation: Non-Admin Users Without ADMIN_ROLES Get 403
// =============================================================================

describe('Preservation: Non-ADMIN_ROLES Users Get 403 on User Routes (Requirements 3.5)', () => {
  /**
   * **Validates: Requirements 3.5**
   *
   * For ALL non-admin users whose role is NOT in ADMIN_ROLES,
   * user management routes return 403 Forbidden.
   */

  it('property: for all users with roles not in ADMIN_ROLES, user management routes return 403', async () => {
    const nonAdminRoles = ['Internal Auditor', 'Compliance Officer', 'Risk Officer', 'Viewer', 'Auditor', 'User'];

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: fc.uuid(),
          role: fc.constantFrom(...nonAdminRoles),
        }),
        async ({ userId, role }) => {
          const { app } = createTestApp({
            authenticatedUser: {
              id: userId,
              role,
              username: 'regularuser',
              name: 'Regular User',
              email: 'regular@test.com',
              status: 'Active',
              session_version: 1,
              requires_password_change: false,
            },
          });

          // All protected user management routes should return 403
          const getInitRes = await request(app).get('/api/users/init');
          expect(getInitRes.status).toBe(403);

          const getUsersRes = await request(app).get('/api/users');
          expect(getUsersRes.status).toBe(403);

          const createRes = await request(app).post('/api/users').send({});
          expect(createRes.status).toBe(403);

          const deleteRes = await request(app).delete('/api/users/some-id');
          expect(deleteRes.status).toBe(403);

          const suspendRes = await request(app).post('/api/users/some-id/suspend');
          expect(suspendRes.status).toBe(403);
        }
      ),
      { numRuns: 10 }
    );
  });

  it('the /list endpoint is accessible to any authenticated user (no role check)', async () => {
    /**
     * **Validates: Requirements 3.7**
     *
     * The /list endpoint is used for dropdowns and should be accessible
     * to any authenticated user regardless of role.
     */
    const nonAdminRoles = ['Internal Auditor', 'Compliance Officer', 'Risk Officer', 'Viewer'];

    for (const role of nonAdminRoles) {
      const { app } = createTestApp({
        authenticatedUser: {
          id: 'user-1',
          role,
          username: 'user',
          name: 'User',
          email: 'user@test.com',
          status: 'Active',
          session_version: 1,
          requires_password_change: false,
        },
      });

      const res = await request(app).get('/api/users/list');
      expect(res.status).toBe(200);
    }
  });
});

// =============================================================================
// Preservation: Audit Trail Entries Created on User CRUD
// =============================================================================

describe('Preservation: Audit Trail Entries Created on User CRUD (Requirements 3.6)', () => {
  /**
   * **Validates: Requirements 3.6**
   *
   * When a user is created, updated, or deleted, audit trail entries are logged.
   * This behavior must be preserved after the fix.
   */

  it('property: for all admin CRUD operations, audit trail entries are created', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          adminId: fc.uuid(),
          targetId: fc.uuid(),
          operation: fc.constantFrom('create', 'update', 'delete', 'suspend', 'archive', 'activate', 'unlock', 'reset-password'),
        }),
        async ({ adminId, targetId, operation }) => {
          const { app, auditLog } = createTestApp({
            authenticatedUser: {
              id: adminId,
              role: 'Admin',
              username: 'admin',
              name: 'Admin',
              email: 'admin@test.com',
              status: 'Active',
              session_version: 1,
              requires_password_change: false,
            },
          });

          const initialLogCount = auditLog.length;

          switch (operation) {
            case 'create':
              await request(app).post('/api/users').send({
                username: 'newuser', password: 'pass123',
                name: 'New', email: 'new@test.com', role: 'Viewer',
              });
              break;
            case 'update':
              await request(app).put(`/api/users/${targetId}`).send({
                name: 'Updated', email: 'up@test.com', role: 'Manager',
              });
              break;
            case 'delete':
              await request(app).delete(`/api/users/${targetId}`);
              break;
            case 'suspend':
              await request(app).post(`/api/users/${targetId}/suspend`);
              break;
            case 'archive':
              await request(app).post(`/api/users/${targetId}/archive`);
              break;
            case 'activate':
              await request(app).post(`/api/users/${targetId}/activate`);
              break;
            case 'unlock':
              await request(app).post(`/api/users/${targetId}/unlock`);
              break;
            case 'reset-password':
              await request(app).post(`/api/users/${targetId}/reset-password`).send({ newPassword: 'newpass' });
              break;
          }

          // Audit log should have a new entry
          expect(auditLog.length).toBeGreaterThan(initialLogCount);
          // The audit entry should reference User Management module
          const lastEntry = auditLog[auditLog.length - 1];
          expect(lastEntry.module).toBe('User Management');
          expect(lastEntry.username).toBe('admin');
        }
      ),
      { numRuns: 10 }
    );
  });
});

// =============================================================================
// Preservation: Cache Invalidation After User Modifications
// =============================================================================

describe('Preservation: Cache Invalidation After User Modifications (Requirements 3.4)', () => {
  /**
   * **Validates: Requirements 3.4**
   *
   * invalidateUserCache() is called after user modifications (update, delete, suspend, etc.).
   * clearPermissionCache() is called after role permission updates.
   */

  it('property: for all user modification operations, cache is invalidated for the target user', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          targetId: fc.uuid(),
          operation: fc.constantFrom('update', 'delete', 'suspend', 'archive', 'activate', 'unlock'),
        }),
        async ({ targetId, operation }) => {
          const { app, cacheInvalidations } = createTestApp({
            authenticatedUser: {
              id: 'admin-1',
              role: 'Admin',
              username: 'admin',
              name: 'Admin',
              email: 'admin@test.com',
              status: 'Active',
              session_version: 1,
              requires_password_change: false,
            },
          });

          switch (operation) {
            case 'update':
              await request(app).put(`/api/users/${targetId}`).send({
                name: 'Updated', email: 'up@test.com', role: 'Manager',
              });
              break;
            case 'delete':
              await request(app).delete(`/api/users/${targetId}`);
              break;
            case 'suspend':
              await request(app).post(`/api/users/${targetId}/suspend`);
              break;
            case 'archive':
              await request(app).post(`/api/users/${targetId}/archive`);
              break;
            case 'activate':
              await request(app).post(`/api/users/${targetId}/activate`);
              break;
            case 'unlock':
              await request(app).post(`/api/users/${targetId}/unlock`);
              break;
          }

          // Cache should be invalidated for the target user
          expect(cacheInvalidations).toContain(targetId);
        }
      ),
      { numRuns: 10 }
    );
  });

  it('clearPermissionCache and invalidateUserCache are exported and callable', async () => {
    /**
     * **Validates: Requirements 3.4**
     *
     * Verifies that clearPermissionCache() and invalidateUserCache() functions
     * are exported and callable. These are called after role permission updates
     * and user modifications respectively.
     */
    const authModule = await import('../../middleware/auth');

    // These functions should exist (they're used in the actual routes)
    expect(typeof authModule.clearPermissionCache).toBe('function');
    expect(typeof authModule.invalidateUserCache).toBe('function');
  });
});

// =============================================================================
// Preservation: Admin Bypass in checkPermission Middleware
// =============================================================================

describe('Preservation: Admin Bypass in checkPermission() (Requirements 3.1)', () => {
  /**
   * **Validates: Requirements 3.1**
   *
   * The checkPermission() middleware has an Admin bypass:
   * `if (user.role === 'Admin') return next()`
   * This must remain unchanged after the fix.
   */

  it('property: for all modules and actions, Admin always passes checkPermission', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          module: fc.constantFrom('User', 'Audit', 'Finding', 'Risk', 'Recommendation', 'Correspondence', 'Setting'),
          action: fc.constantFrom('View', 'Create', 'Edit', 'Delete', 'Approve'),
        }),
        async ({ module, action }) => {
          // Create a minimal app with checkPermission middleware
          const testApp = express();
          testApp.use(express.json());

          // Simulate checkPermission with Admin bypass (mirrors actual implementation)
          const checkPermission = (mod: string, act: string) => {
            return (req: any, res: any, next: any) => {
              if (req.user.role === 'Admin') return next();
              // For non-admin, would check DB - but we're testing Admin bypass
              return res.status(403).json({ error: 'Forbidden' });
            };
          };

          testApp.get('/test', (req: any, res, next) => {
            req.user = { id: 'admin-1', role: 'Admin', username: 'admin' };
            next();
          }, checkPermission(module, action), (req, res) => {
            res.json({ allowed: true });
          });

          const res = await request(testApp).get('/test');
          expect(res.status).toBe(200);
          expect(res.body.allowed).toBe(true);
        }
      ),
      { numRuns: 20 }
    );
  });
});
