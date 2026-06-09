// @vitest-environment node
/**
 * Server Test Helpers
 *
 * Shared utilities for server-side testing including mock database,
 * test Express app creation, and authenticated request helpers.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { vi } from 'vitest';

// ─── Mock Database ───────────────────────────────────────────────────────────

export interface MockDb {
  prepare: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  validateIdentifier: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
  mockGet: ReturnType<typeof vi.fn>;
  mockAll: ReturnType<typeof vi.fn>;
  mockRun: ReturnType<typeof vi.fn>;
}

/**
 * Creates a mock database object matching the DBWrapper interface.
 */
export function createMockDb(): MockDb {
  const mockGet = vi.fn().mockResolvedValue(null);
  const mockAll = vi.fn().mockResolvedValue([]);
  const mockRun = vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 });

  const prepare = vi.fn().mockReturnValue({
    get: mockGet,
    all: mockAll,
    run: mockRun,
  });

  const transaction = vi.fn((fn: Function) => fn());

  const validateIdentifier = vi.fn((name: string) => {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error(`Invalid database identifier: ${name}`);
    }
    return name;
  });

  const exec = vi.fn().mockResolvedValue(undefined);


  return {
    prepare,
    transaction,
    validateIdentifier,
    exec,
    mockGet,
    mockAll,
    mockRun,
  };
}

// ─── Test App Options ────────────────────────────────────────────────────────

export interface CreateTestAppOptions {
  authenticate?: boolean;
  role?: string;
  userId?: string;
  username?: string;
}

export interface TestApp {
  app: express.Application;
  authenticate: express.RequestHandler;
  checkPermission: (module: string, action: string) => express.RequestHandler;
  authorize: (allowedRoles: string[]) => express.RequestHandler;
}

/**
 * Creates a minimal Express app with JSON body parser, cookie parser,
 * and mock authentication/authorization middleware.
 */
export function createTestApp(options?: CreateTestAppOptions): TestApp {
  const opts = {
    authenticate: true,
    role: 'Admin',
    userId: 'test-user-id',
    username: 'testuser',
    ...options,
  };

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const authenticate: express.RequestHandler = (req: any, res, next) => {
    if (!opts.authenticate) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = {
      id: opts.userId,
      role: opts.role,
      username: opts.username,
      name: 'Test User',
      email: `${opts.username}@example.com`,
    };
    next();
  };

  const checkPermission = (module: string, action: string): express.RequestHandler => {
    return (req: any, res, next) => {
      if (req.user?.role === 'Admin') return next();
      next();
    };
  };

  const authorize = (allowedRoles: string[]): express.RequestHandler => {
    return (req: any, res, next) => {
      if (!allowedRoles.includes(req.user?.role)) {
        return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      }
      next();
    };
  };

  return { app, authenticate, checkPermission, authorize };
}

// ─── Authenticated Request Helper ───────────────────────────────────────────

export function createAuthenticatedRequest(
  app: express.Application,
  options?: { token?: string }
) {
  const token = options?.token || 'test-valid-token';
  const agent = request(app);

  return {
    get: (url: string) => agent.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) => agent.post(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) => agent.put(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) => agent.patch(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) => agent.delete(url).set('Authorization', `Bearer ${token}`),
  };
}

// ─── Mock Utility Functions ──────────────────────────────────────────────────

export function mockLogError() {
  return vi.fn();
}

export function mockSaveFile() {
  return vi.fn().mockResolvedValue('/uploads/mock-file.pdf');
}

export function mockCreateNotification() {
  return vi.fn().mockResolvedValue(undefined);
}
