// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { createAuthMiddlewares } from '../../middleware/auth';
import { validateSchema } from '../../middleware/validate';
import { globalErrorHandler } from '../../middleware/error';
import { UserRole } from '@alsaqi/shared';

/**
 * Integration Tests - Middleware Layers
 *
 * Tests authenticate, checkPermission, authorize, validateSchema, and rate limiter
 * middleware in an integration context using supertest with a real Express app.
 */

// Mock jsonwebtoken at module level
vi.mock('jsonwebtoken', () => {
  const JsonWebTokenError = class extends Error {
    name = 'JsonWebTokenError';
    constructor(msg: string) {
      super(msg);
    }
  };
  const TokenExpiredError = class extends Error {
    name = 'TokenExpiredError';
    constructor(msg: string) {
      super(msg);
    }
  };
  return {
    default: {
      verify: vi.fn(),
      sign: vi.fn(),
      JsonWebTokenError,
      TokenExpiredError,
    },
    verify: vi.fn(),
    sign: vi.fn(),
    JsonWebTokenError,
    TokenExpiredError,
  };
});

// Mock express-rate-limit to allow controlling behavior
vi.mock('express-rate-limit', () => ({
  rateLimit: vi.fn((options: any) => {
    // Return a middleware that tracks call count per key
    const store = new Map<string, number>();
    return (req: any, res: any, next: any) => {
      const key = options.keyGenerator ? options.keyGenerator(req) : req.ip;
      const count = (store.get(key) || 0) + 1;
      store.set(key, count);
      if (count > (options.max || 10)) {
        return res.status(429).json(options.message || { error: 'Too many requests' });
      }
      next();
    };
  }),
}));

// Mock ModuleRegistry to return module definitions for test modules
vi.mock('../../permissions/registry', () => ({
  ModuleRegistry: {
    getModule: vi.fn((name: string) => {
      return {
        name,
        label: { en: name, ar: name },
        actions: ['View', 'Create', 'Edit', 'Delete', 'Approve'],
        defaults: {},
      };
    }),
  },
}));

// Mock PermissionService
const mockHasPermission = vi.fn();
vi.mock('../../services/PermissionService', () => ({
  PermissionService: {
    hasPermission: (...args: any[]) => mockHasPermission(...args),
  },
}));

const JWT_SECRET = 'test-secret';
const JWT_PUBLIC_KEY = 'test-public-key';

describe('Middleware Integration Tests', () => {
  let db: any;
  let middlewares: ReturnType<typeof createAuthMiddlewares>;

  beforeEach(() => {
    vi.clearAllMocks();

    db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 0, changes: 0 }),
      }),
    };

    middlewares = createAuthMiddlewares(db, JWT_SECRET, JWT_PUBLIC_KEY);
    middlewares.cache.clear();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    return app;
  }

  describe('authenticate middleware', () => {
    it('returns 401 when no token is provided (no cookie, no header)', async () => {
      const app = createApp();
      app.get('/api/test', middlewares.authenticate, (req: any, res) => {
        res.json({ user: req.user });
      });

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 when token is invalid (JWT verification fails)', async () => {
      vi.mocked(jwt.verify).mockImplementation(() => {
        throw new (jwt as any).JsonWebTokenError('invalid signature');
      });

      const app = createApp();
      app.get('/api/test', middlewares.authenticate, (req: any, res) => {
        res.json({ user: req.user });
      });

      const res = await request(app)
        .get('/api/test')
        .set('Cookie', 'token=invalid-jwt-token');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid token');
    });

    it('returns 403 when user account is suspended', async () => {
      vi.mocked(jwt.verify).mockReturnValue({ id: 'user-1', session_version: 1 } as any);

      db.prepare.mockReturnValue({
        get: vi.fn().mockResolvedValue({
          id: 'user-1',
          role: 'Admin',
          status: 'Suspended',
          username: 'testuser',
          name: 'Test User',
          email: 'test@test.com',
          session_version: 1,
          requires_password_change: false,
        }),
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn(),
      });

      // Recreate middlewares with updated db mock
      middlewares = createAuthMiddlewares(db, JWT_SECRET, JWT_PUBLIC_KEY);
      middlewares.cache.clear();

      const app = createApp();
      app.get('/api/test', middlewares.authenticate, (req: any, res) => {
        res.json({ user: req.user });
      });

      const res = await request(app)
        .get('/api/test')
        .set('Cookie', 'token=valid-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('suspended');
    });

    it('returns 401 when session_version does not match', async () => {
      vi.mocked(jwt.verify).mockReturnValue({ id: 'user-1', session_version: 1 } as any);

      db.prepare.mockReturnValue({
        get: vi.fn().mockResolvedValue({
          id: 'user-1',
          role: 'Admin',
          status: 'Active',
          username: 'testuser',
          name: 'Test User',
          email: 'test@test.com',
          session_version: 2, // Different from token
          requires_password_change: false,
        }),
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn(),
      });

      middlewares = createAuthMiddlewares(db, JWT_SECRET, JWT_PUBLIC_KEY);
      middlewares.cache.clear();

      const app = createApp();
      app.get('/api/test', middlewares.authenticate, (req: any, res) => {
        res.json({ user: req.user });
      });

      const res = await request(app)
        .get('/api/test')
        .set('Cookie', 'token=valid-token');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Session invalidated');
    });

    it('extracts token from Authorization Bearer header when cookie is absent', async () => {
      vi.mocked(jwt.verify).mockReturnValue({ id: 'user-1', session_version: 1 } as any);

      db.prepare.mockReturnValue({
        get: vi.fn().mockResolvedValue({
          id: 'user-1',
          role: 'Admin',
          status: 'Active',
          username: 'testuser',
          name: 'Test User',
          email: 'test@test.com',
          session_version: 1,
          requires_password_change: false,
        }),
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn(),
      });

      middlewares = createAuthMiddlewares(db, JWT_SECRET, JWT_PUBLIC_KEY);
      middlewares.cache.clear();

      const app = createApp();
      app.get('/api/test', middlewares.authenticate, (req: any, res) => {
        res.json({ user: req.user });
      });

      const res = await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer my-bearer-token');

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('testuser');
      expect(jwt.verify).toHaveBeenCalledWith('my-bearer-token', JWT_PUBLIC_KEY, { algorithms: ['RS256'] });
    });

    it('blocks non-auth routes when requires_password_change is true (returns 403 with PASSWORD_CHANGE_REQUIRED)', async () => {
      vi.mocked(jwt.verify).mockReturnValue({ id: 'user-1', session_version: 1 } as any);

      db.prepare.mockReturnValue({
        get: vi.fn().mockResolvedValue({
          id: 'user-1',
          role: 'Admin',
          status: 'Active',
          username: 'testuser',
          name: 'Test User',
          email: 'test@test.com',
          session_version: 1,
          requires_password_change: 1, // truthy in SQLite
        }),
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn(),
      });

      middlewares = createAuthMiddlewares(db, JWT_SECRET, JWT_PUBLIC_KEY);
      middlewares.cache.clear();

      const app = createApp();
      app.get('/api/dashboard', middlewares.authenticate, (req: any, res) => {
        res.json({ data: 'dashboard' });
      });

      const res = await request(app)
        .get('/api/dashboard')
        .set('Cookie', 'token=valid-token');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    });
  });

  describe('checkPermission middleware', () => {
    function createAppWithPermission(module: string, action: string) {
      const app = createApp();

      // Simulate an authenticated user on req.user
      app.use((req: any, res, next) => {
        req.user = { id: 'user-1', role: UserRole.VIEWER };
        next();
      });

      app.get('/api/test', middlewares.checkPermission(module, action as any), (req: any, res) => {
        res.json({ success: true });
      });

      return app;
    }

    it('Admin users bypass all permission checks', async () => {
      const app = createApp();
      app.use((req: any, res, next) => {
        req.user = { id: 'admin-1', role: UserRole.ADMIN };
        next();
      });
      app.get('/api/test', middlewares.checkPermission('Audit', 'Edit'), (req: any, res) => {
        res.json({ success: true });
      });

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 403 with module and action in error message when permission is denied', async () => {
      // Mock PermissionService to deny permission
      mockHasPermission.mockResolvedValue(false);

      middlewares = createAuthMiddlewares(db, JWT_SECRET, JWT_PUBLIC_KEY);
      middlewares.cache.clear();

      const app = createAppWithPermission('Finding', 'Delete');

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Finding');
      expect(res.body.error).toContain('Delete');
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(res.body.module).toBe('Finding');
      expect(res.body.action).toBe('Delete');
    });
  });

  describe('authorize middleware', () => {
    function createAppWithAuthorize(allowedRoles: readonly string[], userRole: string) {
      const app = createApp();
      app.use((req: any, res, next) => {
        req.user = { id: 'user-1', role: userRole };
        next();
      });
      app.get('/api/test', middlewares.authorize(allowedRoles), (req: any, res) => {
        res.json({ success: true });
      });
      return app;
    }

    it('allows access when user role is in allowed roles', async () => {
      const app = createAppWithAuthorize([UserRole.ADMIN, UserRole.MANAGER], UserRole.ADMIN);

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 403 when user role is not in allowed roles', async () => {
      const app = createAppWithAuthorize([UserRole.ADMIN, UserRole.MANAGER], UserRole.VIEWER);

      const res = await request(app).get('/api/test');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Forbidden');
    });
  });

  describe('validateSchema middleware', () => {
    const testSchema = z.object({
      name: z.string().min(2, 'Name must be at least 2 characters'),
      email: z.string().email('Invalid email format'),
      age: z.number().int().positive().optional(),
    });

    function createAppWithValidation() {
      const app = createApp();
      app.post('/api/test', validateSchema(testSchema), (req: any, res) => {
        res.json({ data: req.body });
      });
      app.use(globalErrorHandler);
      return app;
    }

    it('passes when request body matches Zod schema', async () => {
      const app = createAppWithValidation();

      const res = await request(app)
        .post('/api/test')
        .send({ name: 'John', email: 'john@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('John');
      expect(res.body.data.email).toBe('john@example.com');
    });

    it('returns 400 with validation error details when body does not match schema', async () => {
      const app = createAppWithValidation();

      const res = await request(app)
        .post('/api/test')
        .send({ name: 'J', email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('strips unknown fields from the request body', async () => {
      const app = createAppWithValidation();

      const res = await request(app)
        .post('/api/test')
        .send({ name: 'John', email: 'john@example.com', unknownField: 'should be stripped' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('John');
      expect(res.body.data.email).toBe('john@example.com');
      expect(res.body.data.unknownField).toBeUndefined();
    });
  });

  describe('Rate limiter (authLimiter)', () => {
    it('returns 429 with TOO_MANY_ATTEMPTS after exceeding limit', async () => {
      // Create fresh middlewares to get a fresh rate limiter
      const freshMiddlewares = createAuthMiddlewares(db, JWT_SECRET, JWT_PUBLIC_KEY);

      const app = createApp();
      app.post('/api/auth/login', freshMiddlewares.authLimiter, (req: any, res) => {
        res.json({ success: true });
      });

      // Send requests up to the limit (10) - they should pass
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ usernameOrEmail: 'testuser', password: 'pass' });
        expect(res.status).toBe(200);
      }

      // The 11th request should be rate limited
      const res = await request(app)
        .post('/api/auth/login')
        .send({ usernameOrEmail: 'testuser', password: 'pass' });

      expect(res.status).toBe(429);
      expect(res.body.error).toBe('TOO_MANY_ATTEMPTS');
    });
  });
});
