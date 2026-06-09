/**
 * Testing utilities for API middleware and route handler tests.
 * Provides mock Express Request/Response factories and helpers for
 * creating authenticated requests with correlation IDs.
 */
import { vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type { Request, Response, NextFunction } from 'express';

/**
 * Minimal user context attached to authenticated requests.
 * Mirrors the shape set by the auth middleware on `req.user`.
 */
export interface MockUser {
  id: string;
  role: string;
  username: string;
  name: string;
  email: string;
  requires_password_change?: boolean;
}

/**
 * Options for creating a mock Express Request.
 */
export interface MockRequestOptions {
  method?: string;
  url?: string;
  path?: string;
  originalUrl?: string;
  headers?: Record<string, string>;
  body?: any;
  params?: Record<string, string>;
  query?: Record<string, string>;
  user?: MockUser | null;
  ip?: string;
  cookies?: Record<string, string>;
}

/**
 * Extended mock response type with tracking helpers.
 */
export interface MockResponse {
  statusCode: number;
  _headers: Record<string, string>;
  _json: any;
  _ended: boolean;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  getHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  headersSent: boolean;
}


/**
 * Creates a mock Express Request object with configurable properties.
 */
export function createMockRequest(options: MockRequestOptions = {}): Request {
  const {
    method = 'GET',
    url = '/',
    path = '/',
    originalUrl,
    headers = {},
    body = {},
    params = {},
    query = {},
    user = null,
    ip = '127.0.0.1',
    cookies = {},
  } = options;

  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  const req: any = {
    method,
    url,
    path,
    originalUrl: originalUrl ?? url,
    headers: normalizedHeaders,
    body,
    params,
    query,
    ip,
    cookies,
    get: vi.fn((name: string) => normalizedHeaders[name.toLowerCase()]),
    header: vi.fn((name: string) => normalizedHeaders[name.toLowerCase()]),
  };

  if (user) {
    req.user = user;
  }

  return req as Request;
}

/**
 * Creates a mock Express Response object with call tracking.
 */
export function createMockResponse(): MockResponse {
  const res: any = {
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _json: null as any,
    _ended: false,
    headersSent: false,
  };

  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });

  res.json = vi.fn((data: any) => {
    res._json = data;
    res._ended = true;
    res.headersSent = true;
    return res;
  });

  res.send = vi.fn((data: any) => {
    res._json = data;
    res._ended = true;
    res.headersSent = true;
    return res;
  });

  res.end = vi.fn(() => {
    res._ended = true;
    res.headersSent = true;
    return res;
  });

  res.setHeader = vi.fn((name: string, value: string) => {
    res._headers[name.toLowerCase()] = value;
    return res;
  });

  res.getHeader = vi.fn((name: string) => {
    return res._headers[name.toLowerCase()];
  });

  return res as MockResponse;
}

/**
 * Creates a mock next() function for middleware testing.
 */
export function createMockNext(): NextFunction & { mock: { calls: any[][] } } {
  return vi.fn() as unknown as NextFunction & { mock: { calls: any[][] } };
}

/**
 * Default test user for authenticated request helpers.
 */
export const DEFAULT_TEST_USER: MockUser = {
  id: 'user-test-001',
  role: 'Admin',
  username: 'testadmin',
  name: 'Test Admin',
  email: 'admin@test.com',
  requires_password_change: false,
};

/**
 * Creates an authenticated mock request with a user context and correlation ID.
 */
export function createAuthenticatedRequest(
  options: Omit<MockRequestOptions, 'user'> & { user?: Partial<MockUser> } = {}
): Request {
  const { user: userOverrides, headers = {}, ...rest } = options;

  const correlationId = headers['x-correlation-id'] || uuidv4();

  const mergedUser: MockUser = {
    ...DEFAULT_TEST_USER,
    ...userOverrides,
  };

  return createMockRequest({
    ...rest,
    user: mergedUser,
    headers: {
      'x-correlation-id': correlationId,
      ...headers,
    },
  });
}

/**
 * Creates a mock user with a specific role for permission testing.
 */
export function createMockUser(
  role = 'Admin',
  overrides: Partial<MockUser> = {}
): MockUser {
  return {
    id: `user-${role.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
    role,
    username: `test${role.toLowerCase().replace(/\s+/g, '')}`,
    name: `Test ${role}`,
    email: `${role.toLowerCase().replace(/\s+/g, '')}@test.com`,
    requires_password_change: false,
    ...overrides,
  };
}
