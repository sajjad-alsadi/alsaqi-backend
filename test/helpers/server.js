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
/**
 * Creates a mock database object matching the DBWrapper interface.
 * Exposes mockGet, mockAll, mockRun for easy assertion access.
 */
export function createMockDb() {
    const mockGet = vi.fn().mockResolvedValue(null);
    const mockAll = vi.fn().mockResolvedValue([]);
    const mockRun = vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 });
    const prepare = vi.fn().mockReturnValue({
        get: mockGet,
        all: mockAll,
        run: mockRun,
    });
    const transaction = vi.fn((fn) => fn());
    const validateIdentifier = vi.fn((name) => {
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
/**
 * Creates a minimal Express app with JSON body parser, cookie parser,
 * and mock authentication/authorization middleware.
 */
export function createTestApp(options) {
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
    const authenticate = (req, res, next) => {
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
    const checkPermission = (module, action) => {
        return (req, res, next) => {
            if (req.user?.role === 'Admin')
                return next();
            // Default: allow access (can be overridden in specific tests)
            next();
        };
    };
    const authorize = (allowedRoles) => {
        return (req, res, next) => {
            if (!allowedRoles.includes(req.user?.role)) {
                return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
            }
            next();
        };
    };
    return { app, authenticate, checkPermission, authorize };
}
// ─── Authenticated Request Helper ───────────────────────────────────────────
/**
 * Creates a supertest agent with authentication headers pre-set.
 * Returns a supertest Test instance ready for chaining.
 */
export function createAuthenticatedRequest(app, options) {
    const token = options?.token || 'test-valid-token';
    const agent = request(app);
    return {
        get: (url) => agent.get(url).set('Authorization', `Bearer ${token}`),
        post: (url) => agent.post(url).set('Authorization', `Bearer ${token}`),
        put: (url) => agent.put(url).set('Authorization', `Bearer ${token}`),
        patch: (url) => agent.patch(url).set('Authorization', `Bearer ${token}`),
        delete: (url) => agent.delete(url).set('Authorization', `Bearer ${token}`),
    };
}
// ─── Mock Utility Functions ──────────────────────────────────────────────────
/**
 * Mock function for the logError parameter used in route factories.
 * Captures error logging calls for assertion.
 */
export function mockLogError() {
    return vi.fn();
}
/**
 * Mock function for the saveFile parameter used in route factories.
 * Simulates file saving and returns a mock file path.
 */
export function mockSaveFile() {
    return vi.fn().mockResolvedValue('/uploads/mock-file.pdf');
}
/**
 * Mock function for the createNotification parameter used in route factories.
 * Simulates notification creation.
 */
export function mockCreateNotification() {
    return vi.fn().mockResolvedValue(undefined);
}
//# sourceMappingURL=server.js.map