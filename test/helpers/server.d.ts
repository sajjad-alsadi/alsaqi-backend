/**
 * Server Test Helpers
 *
 * Shared utilities for server-side testing including mock database,
 * test Express app creation, and authenticated request helpers.
 */
import express from 'express';
import request from 'supertest';
import { vi } from 'vitest';
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
 * Exposes mockGet, mockAll, mockRun for easy assertion access.
 */
export declare function createMockDb(): MockDb;
export interface CreateTestAppOptions {
    /** Whether authentication succeeds (default: true). If false, returns 401. */
    authenticate?: boolean;
    /** User role for the authenticated user (default: 'Admin') */
    role?: string;
    /** User ID for the authenticated user (default: 'test-user-id') */
    userId?: string;
    /** Username for the authenticated user (default: 'testuser') */
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
export declare function createTestApp(options?: CreateTestAppOptions): TestApp;
/**
 * Creates a supertest agent with authentication headers pre-set.
 * Returns a supertest Test instance ready for chaining.
 */
export declare function createAuthenticatedRequest(app: express.Application, options?: {
    token?: string;
}): {
    get: (url: string) => request.SuperTestStatic.Test;
    post: (url: string) => request.SuperTestStatic.Test;
    put: (url: string) => request.SuperTestStatic.Test;
    patch: (url: string) => request.SuperTestStatic.Test;
    delete: (url: string) => request.SuperTestStatic.Test;
};
/**
 * Mock function for the logError parameter used in route factories.
 * Captures error logging calls for assertion.
 */
export declare function mockLogError(): import("vitest").Mock<import("@vitest/spy").Procedure>;
/**
 * Mock function for the saveFile parameter used in route factories.
 * Simulates file saving and returns a mock file path.
 */
export declare function mockSaveFile(): import("vitest").Mock<import("@vitest/spy").Procedure>;
/**
 * Mock function for the createNotification parameter used in route factories.
 * Simulates notification creation.
 */
export declare function mockCreateNotification(): import("vitest").Mock<import("@vitest/spy").Procedure>;
//# sourceMappingURL=server.d.ts.map