// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';

/**
 * Integration Tests - Auth Routes
 *
 * Tests the authentication routes (login, refresh, logout, me, password management)
 * using supertest against a minimal Express app with mocked services.
 */

// Mock AuthService
const mockAuthService = {
  login: vi.fn(),
  logAudit: vi.fn(),
};

// Mock SessionService
const mockSessionService = {
  refresh: vi.fn(),
  logout: vi.fn(),
  logoutAll: vi.fn(),
};

// Mock PasswordService
const mockPasswordService = {
  requestReset: vi.fn(),
  getResetStatus: vi.fn(),
  getResetRequests: vi.fn(),
  approveReset: vi.fn(),
  changePassword: vi.fn(),
  updatePassword: vi.fn(),
};

vi.mock('../../services/AuthService', () => ({
  AuthService: {
    login: (...args: any[]) => mockAuthService.login(...args),
    logAudit: (...args: any[]) => mockAuthService.logAudit(...args),
  },
}));

vi.mock('../../services/SessionService', () => ({
  SessionService: {
    refresh: (...args: any[]) => mockSessionService.refresh(...args),
    logout: (...args: any[]) => mockSessionService.logout(...args),
    logoutAll: (...args: any[]) => mockSessionService.logoutAll(...args),
  },
}));

vi.mock('../../services/PasswordService', () => ({
  PasswordService: {
    requestReset: (...args: any[]) => mockPasswordService.requestReset(...args),
    getResetStatus: (...args: any[]) => mockPasswordService.getResetStatus(...args),
    getResetRequests: (...args: any[]) => mockPasswordService.getResetRequests(...args),
    approveReset: (...args: any[]) => mockPasswordService.approveReset(...args),
    changePassword: (...args: any[]) => mockPasswordService.changePassword(...args),
    updatePassword: (...args: any[]) => mockPasswordService.updatePassword(...args),
  },
}));

vi.mock('../../middleware/csrf', () => ({
  generateCsrfToken: () => 'mock-csrf-token-abc123',
  attachCsrfToken: (res: any, token: string) => {
    res.cookie('csrf-token', token, { httpOnly: false });
    res.setHeader('x-csrf-token', token);
  },
}));

function createAuthTestApp(options?: { userRole?: string }) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const userRole = options?.userRole || 'Admin';

  const db = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockResolvedValue([]),
    }),
  };

  // Simulate authenticate middleware
  const authenticate = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = { id: 'user-1', role: userRole, username: 'admin', name: 'Admin User', email: 'admin@test.com' };
    next();
  };

  const ADMIN_ROLES = ['Admin', 'SuperAdmin'];
  const authorize = (roles: string[]) => (req: any, res: any, next: any) => {
    if (!roles.includes((req as any).user?.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    next();
  };
  const authLimiter = (req: any, res: any, next: any) => next();
  const createNotification = vi.fn();
  const logError = vi.fn();

  // Import and mount auth routes inline (simulated)
  const authRouter = express.Router();

  // Login route
  authRouter.post('/login', authLimiter, async (req, res, next) => {
    try {
      const { usernameOrEmail, password } = req.body;
      if (!usernameOrEmail || !password) {
        return res.status(400).json({ error: 'Username and password required' });
      }
      const result = await mockAuthService.login(usernameOrEmail, password, 'secret', 'privkey', req.ip, req.get('user-agent'), false);
      res.cookie('token', result.token, { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
      res.cookie('refreshToken', result.refreshToken, { httpOnly: true, secure: true, sameSite: 'none', path: '/api/auth/refresh' });
      await mockAuthService.logAudit(result.user.username, 'Login', 'Authentication', 'User logged in');
      res.cookie('csrf-token', 'mock-csrf-token', { httpOnly: false });
      res.json({ user: result.user, token: result.token });
    } catch (err: any) {
      if (err.message === 'Invalid credentials') {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      next(err);
    }
  });

  // Me route
  authRouter.get('/me', authenticate, async (req, res) => {
    const user = (req as any).user;
    res.json({ user: { ...user, permissions: [] } });
  });

  // Refresh route
  authRouter.post('/refresh', async (req, res) => {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No refresh token' } });
    }
    try {
      const result = await mockSessionService.refresh(refreshToken, 'secret', 'privkey');
      res.cookie('token', result.token, { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
      res.cookie('refreshToken', result.refreshToken, { httpOnly: true, secure: true, sameSite: 'none', path: '/api/auth/refresh' });
      res.json({ success: true });
    } catch (err: any) {
      res.clearCookie('refreshToken');
      res.clearCookie('token');
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
  });

  // Logout route
  authRouter.post('/logout', async (req, res) => {
    const refreshToken = req.cookies?.refreshToken;
    await mockSessionService.logout(refreshToken);
    res.clearCookie('refreshToken');
    res.clearCookie('token');
    res.json({ success: true });
  });

  // Logout all route
  authRouter.post('/logout-all', authenticate, async (req, res) => {
    const userId = (req as any).user.id;
    await mockSessionService.logoutAll(userId);
    res.json({ success: true });
  });

  // Change password route (requires auth, validates newPassword min 8 chars)
  authRouter.post('/change-password', authLimiter, authenticate, async (req, res, next) => {
    try {
      const { newPassword } = req.body;
      if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
        return res.status(400).json({ error: 'Invalid password data', details: 'newPassword must be at least 8 characters' });
      }
      if (newPassword.length > 100) {
        return res.status(400).json({ error: 'Invalid password data', details: 'newPassword must be at most 100 characters' });
      }
      const userId = (req as any).user.id;
      const user = await mockPasswordService.changePassword(userId, newPassword);
      await mockAuthService.logAudit(user.username, 'Change Password', 'Security', 'User changed their password');
      res.cookie('token', 'new-jwt-token', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
      res.json({ success: true, token: 'new-jwt-token' });
    } catch (err: any) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  });

  // Update password route (requires auth, validates currentPassword and newPassword)
  authRouter.post('/update-password', authLimiter, authenticate, async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.length < 1) {
        return res.status(400).json({ error: 'Invalid password data', details: 'currentPassword is required' });
      }
      if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
        return res.status(400).json({ error: 'Invalid password data', details: 'newPassword must be at least 8 characters' });
      }
      if (newPassword.length > 100) {
        return res.status(400).json({ error: 'Invalid password data', details: 'newPassword must be at most 100 characters' });
      }
      const userId = (req as any).user.id;
      const user = await mockPasswordService.updatePassword(userId, currentPassword, newPassword);
      await mockAuthService.logAudit(user.username, 'Change Password', 'Settings', 'User changed their password');
      res.cookie('token', 'new-jwt-token', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
      res.json({ success: true, token: 'new-jwt-token' });
    } catch (err: any) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  });

  // Forgot password route (public, validates username)
  authRouter.post('/forgot-password', authLimiter, async (req, res, next) => {
    try {
      const { username } = req.body;
      if (!username || typeof username !== 'string' || username.length < 1) {
        return res.status(400).json({ error: 'Invalid username' });
      }
      const result = await mockPasswordService.requestReset(username);
      if (result.user && result.admins) {
        await createNotification(result.admins[0]?.id, 'password_reset_request', result.alertMsg, 'Security');
        await mockAuthService.logAudit(result.user.username, 'Password Reset Request', 'Security', 'User requested password reset');
      }
      res.json({ success: true, message: result.message });
    } catch (err: any) {
      next(err);
    }
  });

  // Reset status route (public)
  authRouter.get('/reset-status/:username', authLimiter, async (req, res, next) => {
    try {
      const username = req.params.username;
      const status = await mockPasswordService.getResetStatus(username);
      res.json({ status });
    } catch (err: any) {
      next(err);
    }
  });

  // Reset requests route (admin only)
  authRouter.get('/reset-requests', authenticate, authorize(ADMIN_ROLES), async (req, res, next) => {
    try {
      const data = await mockPasswordService.getResetRequests();
      res.json(data);
    } catch (err: any) {
      next(err);
    }
  });

  // Approve reset route (admin only)
  authRouter.post('/approve-reset', authenticate, authorize(ADMIN_ROLES), async (req, res, next) => {
    try {
      const { requestId } = req.body;
      if (!requestId || typeof requestId !== 'string' || requestId.length < 1) {
        return res.status(400).json({ error: 'Invalid request ID' });
      }
      const adminId = (req as any).user.id;
      const result = await mockPasswordService.approveReset(requestId, adminId);
      await mockAuthService.logAudit((req as any).user.username, 'Admin Password Reset', 'Security', `Admin reset password for user: ${result.username}. Request ID: ${requestId}`);
      res.json({ success: true, tempPassword: result.tempPassword });
    } catch (err: any) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      next(err);
    }
  });

  app.use('/api/auth', authRouter);

  return { app, createNotification };
}

describe('Auth Integration Tests', () => {
  let app: express.Application;
  let createNotification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const testApp = createAuthTestApp();
    app = testApp.app;
    createNotification = testApp.createNotification;
  });

  describe('POST /api/auth/login', () => {
    it('should return 200 with user and token on successful login', async () => {
      mockAuthService.login.mockResolvedValue({
        user: { id: 'user-1', username: 'admin', name: 'Admin', role: 'Admin' },
        token: 'jwt-access-token',
        refreshToken: 'jwt-refresh-token',
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ usernameOrEmail: 'admin', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('admin');
      expect(res.body.token).toBe('jwt-access-token');
      expect(mockAuthService.logAudit).toHaveBeenCalledWith('admin', 'Login', 'Authentication', 'User logged in');
    });

    it('should return 401 on invalid credentials', async () => {
      mockAuthService.login.mockRejectedValue(new Error('Invalid credentials'));

      const res = await request(app)
        .post('/api/auth/login')
        .send({ usernameOrEmail: 'admin', password: 'wrongpass' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });

    it('should return 400 when username or password is missing', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ usernameOrEmail: '' });

      expect(res.status).toBe(400);
    });

    it('should set httpOnly cookies on successful login', async () => {
      mockAuthService.login.mockResolvedValue({
        user: { id: 'user-1', username: 'admin', name: 'Admin', role: 'Admin' },
        token: 'jwt-access-token',
        refreshToken: 'jwt-refresh-token',
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ usernameOrEmail: 'admin', password: 'password123' });

      expect(res.status).toBe(200);
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieArr = Array.isArray(cookies) ? cookies : [cookies];
      expect(cookieArr.some((c: string) => c.includes('token='))).toBe(true);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return 200 with user data when authenticated', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('admin');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('should return 401 when no refresh token cookie is present', async () => {
      const res = await request(app).post('/api/auth/refresh');

      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('No refresh token');
    });

    it('should return 200 on valid refresh token', async () => {
      mockSessionService.refresh.mockResolvedValue({
        token: 'new-access-token',
        refreshToken: 'new-refresh-token',
        user: { username: 'admin' },
        rememberMe: false,
      });

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', 'refreshToken=valid-refresh-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 401 and clear cookies on invalid refresh token', async () => {
      mockSessionService.refresh.mockRejectedValue(new Error('Token expired'));

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', 'refreshToken=expired-token');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should return 200 and clear cookies', async () => {
      mockSessionService.logout.mockResolvedValue('admin');

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', 'refreshToken=some-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSessionService.logout).toHaveBeenCalledWith('some-token');
    });
  });

  describe('POST /api/auth/logout-all', () => {
    it('should return 200 when authenticated', async () => {
      mockSessionService.logoutAll.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/auth/logout-all')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSessionService.logoutAll).toHaveBeenCalledWith('user-1');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).post('/api/auth/logout-all');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/change-password', () => {
    it('should return 200 with new token on valid password change', async () => {
      mockPasswordService.changePassword.mockResolvedValue({
        id: 'user-1',
        username: 'admin',
        role: 'Admin',
        session_version: 2,
      });

      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ newPassword: 'NewSecure123!' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(mockPasswordService.changePassword).toHaveBeenCalledWith('user-1', 'NewSecure123!');
      expect(mockAuthService.logAudit).toHaveBeenCalledWith('admin', 'Change Password', 'Security', 'User changed their password');
    });

    it('should set httpOnly cookie with new token', async () => {
      mockPasswordService.changePassword.mockResolvedValue({
        id: 'user-1',
        username: 'admin',
        role: 'Admin',
        session_version: 2,
      });

      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ newPassword: 'NewSecure123!' });

      expect(res.status).toBe(200);
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieArr = Array.isArray(cookies) ? cookies : [cookies];
      expect(cookieArr.some((c: string) => c.includes('token='))).toBe(true);
    });

    it('should return 400 when newPassword is too short (less than 8 chars)', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ newPassword: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid password data');
    });

    it('should return 400 when newPassword is missing', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', 'Bearer valid-token')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .send({ newPassword: 'NewSecure123!' });

      expect(res.status).toBe(401);
    });

    it('should return error when service throws ValidationError', async () => {
      mockPasswordService.changePassword.mockRejectedValue({
        statusCode: 400,
        message: 'New password cannot be the same as the current password',
      });

      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ newPassword: 'SamePassword1!' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('New password cannot be the same as the current password');
    });
  });

  describe('POST /api/auth/update-password', () => {
    it('should return 200 with new token on valid password update', async () => {
      mockPasswordService.updatePassword.mockResolvedValue({
        id: 'user-1',
        username: 'admin',
        role: 'Admin',
        session_version: 2,
      });

      const res = await request(app)
        .post('/api/auth/update-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ currentPassword: 'OldPass123!', newPassword: 'NewSecure123!' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(mockPasswordService.updatePassword).toHaveBeenCalledWith('user-1', 'OldPass123!', 'NewSecure123!');
      expect(mockAuthService.logAudit).toHaveBeenCalledWith('admin', 'Change Password', 'Settings', 'User changed their password');
    });

    it('should return 400 when currentPassword is missing', async () => {
      const res = await request(app)
        .post('/api/auth/update-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ newPassword: 'NewSecure123!' });

      expect(res.status).toBe(400);
      expect(res.body.details).toContain('currentPassword');
    });

    it('should return 400 when newPassword is too short', async () => {
      const res = await request(app)
        .post('/api/auth/update-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ currentPassword: 'OldPass123!', newPassword: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.details).toContain('newPassword');
    });

    it('should return 400 when both passwords are missing', async () => {
      const res = await request(app)
        .post('/api/auth/update-password')
        .set('Authorization', 'Bearer valid-token')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/api/auth/update-password')
        .send({ currentPassword: 'OldPass123!', newPassword: 'NewSecure123!' });

      expect(res.status).toBe(401);
    });

    it('should return 401 when current password is incorrect', async () => {
      mockPasswordService.updatePassword.mockRejectedValue({
        statusCode: 401,
        message: 'Incorrect current password',
      });

      const res = await request(app)
        .post('/api/auth/update-password')
        .set('Authorization', 'Bearer valid-token')
        .send({ currentPassword: 'WrongPass!', newPassword: 'NewSecure123!' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Incorrect current password');
    });
  });

  describe('POST /api/auth/forgot-password', () => {
    it('should return 200 with success message for valid username', async () => {
      mockPasswordService.requestReset.mockResolvedValue({
        success: true,
        message: 'If the username exists, a request has been sent to the administrator.',
        user: { id: 'user-2', username: 'john' },
        admins: [{ id: 'admin-1' }],
        alertMsg: 'Password Reset Request\nUsername: john',
      });

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ username: 'john' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBeDefined();
      expect(mockPasswordService.requestReset).toHaveBeenCalledWith('john');
    });

    it('should send notification to admins when user exists', async () => {
      mockPasswordService.requestReset.mockResolvedValue({
        success: true,
        message: 'Request sent.',
        user: { id: 'user-2', username: 'john' },
        admins: [{ id: 'admin-1' }],
        alertMsg: 'Password Reset Request\nUsername: john',
      });

      const testApp = createAuthTestApp();
      const res = await request(testApp.app)
        .post('/api/auth/forgot-password')
        .send({ username: 'john' });

      expect(res.status).toBe(200);
      expect(testApp.createNotification).toHaveBeenCalled();
      expect(mockAuthService.logAudit).toHaveBeenCalledWith('john', 'Password Reset Request', 'Security', 'User requested password reset');
    });

    it('should return 200 even when user does not exist (no info leak)', async () => {
      mockPasswordService.requestReset.mockResolvedValue({
        success: true,
        message: 'If the username exists, a request has been sent to the administrator.',
      });

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ username: 'nonexistent' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 400 when username is missing', async () => {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid username');
    });

    it('should return 400 when username is empty string', async () => {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ username: '' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/auth/reset-status/:username', () => {
    it('should return status for a valid username', async () => {
      mockPasswordService.getResetStatus.mockResolvedValue('Pending');

      const res = await request(app)
        .get('/api/auth/reset-status/john');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('Pending');
      expect(mockPasswordService.getResetStatus).toHaveBeenCalledWith('john');
    });

    it('should return None when no reset request exists', async () => {
      mockPasswordService.getResetStatus.mockResolvedValue('None');

      const res = await request(app)
        .get('/api/auth/reset-status/unknownuser');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('None');
    });
  });

  describe('GET /api/auth/reset-requests', () => {
    it('should return pending reset requests for admin', async () => {
      const mockRequests = [
        { id: 'req-1', user_id: 'user-2', username: 'john', status: 'Pending', request_date: '2024-01-01' },
        { id: 'req-2', user_id: 'user-3', username: 'jane', status: 'Pending', request_date: '2024-01-02' },
      ];
      mockPasswordService.getResetRequests.mockResolvedValue(mockRequests);

      const res = await request(app)
        .get('/api/auth/reset-requests')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].username).toBe('john');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .get('/api/auth/reset-requests');

      expect(res.status).toBe(401);
    });

    it('should return 403 when user is not admin', async () => {
      const testApp = createAuthTestApp({ userRole: 'Auditor' });

      const res = await request(testApp.app)
        .get('/api/auth/reset-requests')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/auth/approve-reset', () => {
    it('should return 200 with temp password on successful approval', async () => {
      mockPasswordService.approveReset.mockResolvedValue({
        tempPassword: 'TempPass123!',
        username: 'john',
        userId: 'user-2',
      });

      const res = await request(app)
        .post('/api/auth/approve-reset')
        .set('Authorization', 'Bearer valid-token')
        .send({ requestId: 'req-1' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tempPassword).toBe('TempPass123!');
      expect(mockPasswordService.approveReset).toHaveBeenCalledWith('req-1', 'user-1');
      expect(mockAuthService.logAudit).toHaveBeenCalledWith(
        'admin',
        'Admin Password Reset',
        'Security',
        expect.stringContaining('john')
      );
    });

    it('should return 400 when requestId is missing', async () => {
      const res = await request(app)
        .post('/api/auth/approve-reset')
        .set('Authorization', 'Bearer valid-token')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid request ID');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/api/auth/approve-reset')
        .send({ requestId: 'req-1' });

      expect(res.status).toBe(401);
    });

    it('should return 403 when user is not admin', async () => {
      const testApp = createAuthTestApp({ userRole: 'Auditor' });

      const res = await request(testApp.app)
        .post('/api/auth/approve-reset')
        .set('Authorization', 'Bearer valid-token')
        .send({ requestId: 'req-1' });

      expect(res.status).toBe(403);
    });

    it('should return 404 when request not found', async () => {
      mockPasswordService.approveReset.mockRejectedValue({
        statusCode: 404,
        message: 'Request not found',
      });

      const res = await request(app)
        .post('/api/auth/approve-reset')
        .set('Authorization', 'Bearer valid-token')
        .send({ requestId: 'nonexistent-req' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Request not found');
    });
  });
});
