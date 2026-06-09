// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@alsaqi/shared';

/**
 * Integration Tests - Users Routes
 *
 * Tests the user management routes using supertest against a minimal Express app.
 * Covers CRUD operations, authentication requirements, authorization, error handling,
 * self-protection, last admin protection, archive, activate, unlock, and reset-password.
 */

interface MockUser {
  id: string;
  username: string;
  name: string;
  email: string;
  role: string;
  department: string;
  status: string;
  failed_attempts: number;
  locked_until: string | null;
}

function createUsersTestApp(options?: {
  authenticatedRole?: string;
  authenticatedUserId?: string;
}) {
  const app = express();
  app.use(express.json());

  const users: MockUser[] = [
    {
      id: 'user-1',
      username: 'admin',
      name: 'Admin User',
      email: 'admin@company.com',
      role: UserRole.ADMIN,
      department: 'IT',
      status: 'Active',
      failed_attempts: 0,
      locked_until: null,
    },
    {
      id: 'user-2',
      username: 'auditor1',
      name: 'John Auditor',
      email: 'john@company.com',
      role: UserRole.INTERNAL_AUDITOR,
      department: 'Audit',
      status: 'Active',
      failed_attempts: 0,
      locked_until: null,
    },
    {
      id: 'user-3',
      username: 'suspended_user',
      name: 'Suspended User',
      email: 'suspended@company.com',
      role: UserRole.VIEWER,
      department: 'Finance',
      status: 'Suspended',
      failed_attempts: 3,
      locked_until: null,
    },
    {
      id: 'user-4',
      username: 'locked_user',
      name: 'Locked User',
      email: 'locked@company.com',
      role: UserRole.VIEWER,
      department: 'HR',
      status: 'Active',
      failed_attempts: 5,
      locked_until: new Date(Date.now() + 900000).toISOString(),
    },
  ];

  const authenticatedRole = options?.authenticatedRole || UserRole.ADMIN;
  const authenticatedUserId = options?.authenticatedUserId || 'auth-user-1';

  const authenticate = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = {
      id: authenticatedUserId,
      role: authenticatedRole,
      username: 'admin',
      name: 'Admin User',
      email: 'admin@test.com',
    };
    next();
  };

  const checkPermission = (module: string, action: string) => (req: any, res: any, next: any) => {
    if (req.user.role === UserRole.ADMIN) return next();
    return res.status(403).json({ error: `Forbidden: Missing permission ${action} on ${module}` });
  };

  const authorize = (roles: readonly string[]) => (req: any, res: any, next: any) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    next();
  };

  const notificationsSent: any[] = [];

  const router = express.Router();

  // GET /init
  router.get('/init', authenticate, checkPermission('User', 'View'), (req, res) => {
    res.json({ roles: Object.values(UserRole), departments: ['IT', 'Audit', 'Finance', 'HR'] });
  });

  // GET all users
  router.get('/', authenticate, checkPermission('User', 'View'), (req, res) => {
    const { status, department, role } = req.query;
    let filtered = [...users];
    if (status) filtered = filtered.filter(u => u.status === status);
    if (department) filtered = filtered.filter(u => u.department === department);
    if (role) filtered = filtered.filter(u => u.role === role);
    res.json({ data: filtered, total: filtered.length });
  });

  // GET /summary
  router.get('/summary', authenticate, checkPermission('User', 'View'), (req, res) => {
    res.json({
      total: users.length,
      active: users.filter(u => u.status === 'Active').length,
      suspended: users.filter(u => u.status === 'Suspended').length,
      archived: users.filter(u => u.status === 'Archived').length,
    });
  });

  // GET /list (accessible to all authenticated users)
  router.get('/list', authenticate, (req, res) => {
    res.json(users.filter(u => u.status === 'Active').map(u => ({ id: u.id, name: u.name, role: u.role })));
  });

  // GET /:id
  router.get('/:id', authenticate, checkPermission('User', 'View'), (req, res) => {
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });

  // POST create user
  router.post('/', authenticate, checkPermission('User', 'Create'), (req, res) => {
    const { username, password, name, email, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required for new users' });
    }
    if (!name || !email || !role) {
      return res.status(400).json({ error: 'Name, email, and role are required' });
    }
    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({ error: 'Username must be between 3 and 50 characters' });
    }
    if (password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: 'Password must be between 6 and 100 characters' });
    }
    if (name.length < 1 || name.length > 100) {
      return res.status(400).json({ error: 'Name must be between 1 and 100 characters' });
    }
    // Check duplicate username
    if (users.find(u => u.username === username)) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    const newUser: MockUser = {
      id: `user-${Date.now()}`,
      username,
      name,
      email,
      role,
      department: req.body.department || '',
      status: 'Active',
      failed_attempts: 0,
      locked_until: null,
    };
    users.push(newUser);
    res.status(201).json(newUser);
  });

  // PUT update user (with role/status change notification)
  router.put('/:id', authenticate, checkPermission('User', 'Edit'), (req, res) => {
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    const oldUser = { ...users[idx] };
    users[idx] = { ...users[idx], ...req.body };
    // Detect role/status change and send notification (only when explicitly provided and different)
    const roleChanged = req.body.role !== undefined && oldUser.role !== req.body.role;
    const statusChanged = req.body.status !== undefined && oldUser.status !== req.body.status;
    if (roleChanged || statusChanged) {
      notificationsSent.push({
        userId: req.params.id,
        type: 'permission_changed',
        oldRole: oldUser.role,
        newRole: req.body.role || oldUser.role,
        oldStatus: oldUser.status,
        newStatus: req.body.status || oldUser.status,
      });
    }
    res.json({ success: true });
  });

  // POST suspend (with self-protection + last admin protection)
  router.post('/:id/suspend', authenticate, checkPermission('User', 'Edit'), (req, res) => {
    const id = req.params.id;
    if ((req as any).user.id === id) {
      return res.status(403).json({ error: 'Cannot perform this action on your own account' });
    }
    const targetUser = users.find(u => u.id === id);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    // Last admin protection
    if (targetUser.role === UserRole.ADMIN) {
      const activeAdmins = users.filter(u => u.role === UserRole.ADMIN && u.status === 'Active' && u.id !== id);
      if (activeAdmins.length === 0) {
        return res.status(403).json({ error: 'Cannot remove the last admin user' });
      }
    }
    targetUser.status = targetUser.status === 'Suspended' ? 'Active' : 'Suspended';
    res.json({ success: true, status: targetUser.status });
  });

  // POST archive (with self-protection + last admin protection)
  router.post('/:id/archive', authenticate, checkPermission('User', 'Edit'), (req, res) => {
    const id = req.params.id;
    if ((req as any).user.id === id) {
      return res.status(403).json({ error: 'Cannot perform this action on your own account' });
    }
    const targetUser = users.find(u => u.id === id);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    // Last admin protection
    if (targetUser.role === UserRole.ADMIN) {
      const activeAdmins = users.filter(u => u.role === UserRole.ADMIN && u.status === 'Active' && u.id !== id);
      if (activeAdmins.length === 0) {
        return res.status(403).json({ error: 'Cannot remove the last admin user' });
      }
    }
    targetUser.status = 'Archived';
    res.json({ success: true });
  });

  // POST activate
  router.post('/:id/activate', authenticate, checkPermission('User', 'Edit'), (req, res) => {
    const targetUser = users.find(u => u.id === req.params.id);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    targetUser.status = 'Active';
    res.json({ success: true });
  });

  // POST unlock (resets failed_attempts and locked_until)
  router.post('/:id/unlock', authenticate, checkPermission('User', 'Edit'), (req, res) => {
    const targetUser = users.find(u => u.id === req.params.id);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    targetUser.failed_attempts = 0;
    targetUser.locked_until = null;
    res.json({ success: true });
  });

  // DELETE user (with self-protection + last admin protection)
  router.delete('/:id', authenticate, checkPermission('User', 'Delete'), (req, res) => {
    const id = req.params.id;
    if ((req as any).user.id === id) {
      return res.status(403).json({ error: 'Cannot perform this action on your own account' });
    }
    const targetUser = users.find(u => u.id === id);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    // Last admin protection
    if (targetUser.role === UserRole.ADMIN) {
      const activeAdmins = users.filter(u => u.role === UserRole.ADMIN && u.status === 'Active' && u.id !== id);
      if (activeAdmins.length === 0) {
        return res.status(403).json({ error: 'Cannot remove the last admin user' });
      }
    }
    const idx = users.findIndex(u => u.id === id);
    users.splice(idx, 1);
    res.json({ success: true });
  });

  // POST reset-password (validates min 6 chars)
  router.post('/:id/reset-password', authenticate, checkPermission('User', 'Edit'), (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Invalid password data' });
    }
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  });

  app.use('/api/users', router);

  return { app, users, notificationsSent };
}

describe('Users Integration Tests', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    const testApp = createUsersTestApp();
    app = testApp.app;
  });

  describe('GET /api/users', () => {
    it('should return 200 with list of users when authenticated as Admin', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.length).toBe(4);
      expect(res.body.total).toBe(4);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/users');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should filter by status', async () => {
      const res = await request(app)
        .get('/api/users?status=Active')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.every((u: any) => u.status === 'Active')).toBe(true);
    });

    it('should filter by department', async () => {
      const res = await request(app)
        .get('/api/users?department=IT')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].department).toBe('IT');
    });

    it('should filter by role', async () => {
      const res = await request(app)
        .get(`/api/users?role=${UserRole.VIEWER}`)
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.data.every((u: any) => u.role === UserRole.VIEWER)).toBe(true);
    });
  });

  describe('GET /api/users/init', () => {
    it('should return roles and departments', async () => {
      const res = await request(app)
        .get('/api/users/init')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.roles).toBeDefined();
      expect(res.body.departments).toBeDefined();
      expect(Array.isArray(res.body.roles)).toBe(true);
      expect(Array.isArray(res.body.departments)).toBe(true);
    });
  });

  describe('GET /api/users/summary', () => {
    it('should return user count summary', async () => {
      const res = await request(app)
        .get('/api/users/summary')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(4);
      expect(res.body.active).toBe(3);
      expect(res.body.suspended).toBe(1);
    });
  });

  describe('GET /api/users/list', () => {
    it('should return active users list (accessible to all authenticated users)', async () => {
      const res = await request(app)
        .get('/api/users/list')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(3); // Only active users
      expect(res.body.every((u: any) => u.id && u.name && u.role)).toBe(true);
    });
  });

  describe('GET /api/users/:id', () => {
    it('should return user details for valid ID', async () => {
      const res = await request(app)
        .get('/api/users/user-2')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('user-2');
      expect(res.body.username).toBe('auditor1');
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(app)
        .get('/api/users/non-existent')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('User not found');
    });
  });

  describe('POST /api/users', () => {
    it('should return 201 with created user on valid data', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', 'Bearer valid-token')
        .send({
          username: 'newuser',
          password: 'securepass123',
          name: 'New User',
          email: 'newuser@company.com',
          role: UserRole.VIEWER,
          department: 'HR',
        });

      expect(res.status).toBe(201);
      expect(res.body.username).toBe('newuser');
      expect(res.body.role).toBe(UserRole.VIEWER);
      expect(res.body.status).toBe('Active');
    });

    it('should return 400 when username or password is missing', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', 'Bearer valid-token')
        .send({ name: 'No Creds', email: 'no@creds.com', role: 'Viewer' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Username and password');
    });

    it('should return 400 when name, email, or role is missing', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', 'Bearer valid-token')
        .send({ username: 'testuser2', password: 'pass123456' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Name, email, and role are required');
    });

    it('should return 400 when username is too short', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', 'Bearer valid-token')
        .send({
          username: 'ab',
          password: 'securepass123',
          name: 'Short Username',
          email: 'short@company.com',
          role: UserRole.VIEWER,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Username must be between 3 and 50');
    });

    it('should return 400 when password is too short', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', 'Bearer valid-token')
        .send({
          username: 'validuser',
          password: '12345',
          name: 'Short Pass',
          email: 'shortpass@company.com',
          role: UserRole.VIEWER,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Password must be between 6 and 100');
    });

    it('should return 409 when username already exists', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', 'Bearer valid-token')
        .send({
          username: 'admin',
          password: 'pass123456',
          name: 'Duplicate',
          email: 'dup@company.com',
          role: 'Viewer',
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });
  });

  describe('PUT /api/users/:id', () => {
    it('should return 200 on successful update', async () => {
      const res = await request(app)
        .put('/api/users/user-2')
        .set('Authorization', 'Bearer valid-token')
        .send({ name: 'Updated Name', department: 'Security' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(app)
        .put('/api/users/non-existent')
        .set('Authorization', 'Bearer valid-token')
        .send({ name: 'Updated' });

      expect(res.status).toBe(404);
    });

    it('should send notification when role changes', async () => {
      const { app: testApp, notificationsSent } = createUsersTestApp();

      await request(testApp)
        .put('/api/users/user-2')
        .set('Authorization', 'Bearer valid-token')
        .send({ role: UserRole.MANAGER, name: 'John Auditor', email: 'john@company.com' });

      expect(notificationsSent.length).toBe(1);
      expect(notificationsSent[0].userId).toBe('user-2');
      expect(notificationsSent[0].type).toBe('permission_changed');
      expect(notificationsSent[0].oldRole).toBe(UserRole.INTERNAL_AUDITOR);
      expect(notificationsSent[0].newRole).toBe(UserRole.MANAGER);
    });

    it('should send notification when status changes', async () => {
      const { app: testApp, notificationsSent } = createUsersTestApp();

      await request(testApp)
        .put('/api/users/user-2')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'Suspended', name: 'John Auditor', email: 'john@company.com' });

      expect(notificationsSent.length).toBe(1);
      expect(notificationsSent[0].oldStatus).toBe('Active');
      expect(notificationsSent[0].newStatus).toBe('Suspended');
    });

    it('should not send notification when role/status unchanged', async () => {
      const { app: testApp, notificationsSent } = createUsersTestApp();

      await request(testApp)
        .put('/api/users/user-2')
        .set('Authorization', 'Bearer valid-token')
        .send({ name: 'New Name Only' });

      expect(notificationsSent.length).toBe(0);
    });
  });

  describe('POST /api/users/:id/suspend', () => {
    it('should toggle user suspension status', async () => {
      const res = await request(app)
        .post('/api/users/user-2/suspend')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('Suspended');
    });

    it('should toggle back from Suspended to Active', async () => {
      const res = await request(app)
        .post('/api/users/user-3/suspend')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('Active');
    });

    it('should return 403 when trying to suspend yourself', async () => {
      const res = await request(app)
        .post('/api/users/auth-user-1/suspend')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('own account');
    });

    it('should return 403 when trying to suspend the last active admin', async () => {
      const res = await request(app)
        .post('/api/users/user-1/suspend')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot remove the last admin user');
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(app)
        .post('/api/users/non-existent/suspend')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/users/:id/archive', () => {
    it('should archive a user successfully', async () => {
      const res = await request(app)
        .post('/api/users/user-2/archive')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 403 when trying to archive yourself', async () => {
      const res = await request(app)
        .post('/api/users/auth-user-1/archive')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('own account');
    });

    it('should return 403 when trying to archive the last active admin', async () => {
      const res = await request(app)
        .post('/api/users/user-1/archive')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot remove the last admin user');
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(app)
        .post('/api/users/non-existent/archive')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/users/:id/activate', () => {
    it('should activate a suspended user', async () => {
      const res = await request(app)
        .post('/api/users/user-3/activate')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(app)
        .post('/api/users/non-existent/activate')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/users/:id/unlock', () => {
    it('should unlock a locked user and reset failed attempts', async () => {
      const { app: testApp, users } = createUsersTestApp();
      const lockedUser = users.find(u => u.id === 'user-4')!;
      expect(lockedUser.failed_attempts).toBe(5);
      expect(lockedUser.locked_until).not.toBeNull();

      const res = await request(testApp)
        .post('/api/users/user-4/unlock')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Verify the user state was reset
      expect(lockedUser.failed_attempts).toBe(0);
      expect(lockedUser.locked_until).toBeNull();
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(app)
        .post('/api/users/non-existent/unlock')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/users/:id', () => {
    it('should return 200 on successful deletion', async () => {
      const res = await request(app)
        .delete('/api/users/user-3')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 403 when trying to delete yourself', async () => {
      const res = await request(app)
        .delete('/api/users/auth-user-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('own account');
    });

    it('should return 403 when trying to delete the last active admin', async () => {
      const res = await request(app)
        .delete('/api/users/user-1')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot remove the last admin user');
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(app)
        .delete('/api/users/non-existent')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/users/:id/reset-password', () => {
    it('should return 200 on valid password reset', async () => {
      const res = await request(app)
        .post('/api/users/user-2/reset-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ newPassword: 'newSecurePass123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 400 when password is too short (less than 6 chars)', async () => {
      const res = await request(app)
        .post('/api/users/user-2/reset-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ newPassword: 'ab' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid password data');
    });

    it('should return 400 when newPassword is missing', async () => {
      const res = await request(app)
        .post('/api/users/user-2/reset-password')
        .set('Authorization', 'Bearer valid-token')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(app)
        .post('/api/users/non-existent/reset-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ newPassword: 'validPass123' });

      expect(res.status).toBe(404);
    });
  });

  describe('Authorization - Non-Admin users', () => {
    it('should return 403 for non-admin users on protected routes', async () => {
      const { app: viewerApp } = createUsersTestApp({ authenticatedRole: UserRole.VIEWER });

      const res = await request(viewerApp)
        .get('/api/users')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
    });

    it('should allow non-admin users to access /list endpoint', async () => {
      const { app: viewerApp } = createUsersTestApp({ authenticatedRole: UserRole.VIEWER });

      const res = await request(viewerApp)
        .get('/api/users/list')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
    });

    it('should return 403 for non-admin on create user', async () => {
      const { app: viewerApp } = createUsersTestApp({ authenticatedRole: UserRole.VIEWER });

      const res = await request(viewerApp)
        .post('/api/users')
        .set('Authorization', 'Bearer valid-token')
        .send({
          username: 'newuser',
          password: 'pass123456',
          name: 'New',
          email: 'new@test.com',
          role: 'Viewer',
        });

      expect(res.status).toBe(403);
    });

    it('should return 403 for non-admin on delete user', async () => {
      const { app: viewerApp } = createUsersTestApp({ authenticatedRole: UserRole.VIEWER });

      const res = await request(viewerApp)
        .delete('/api/users/user-2')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
    });
  });
});
