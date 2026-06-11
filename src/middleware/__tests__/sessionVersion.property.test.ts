// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

/**
 * Property Test: Session Version Invalidation (Property 4)
 *
 * **Validates: Requirements 1.5, 19.3**
 *
 * For any authenticated request where the user's database `session_version`
 * differs from the token's `session_version` claim, the Auth_Middleware SHALL
 * reject the request with HTTP 401, regardless of other token validity.
 */

// Mock Redis to avoid real connections
vi.mock('../../cache/redisManager.js', () => ({
  redisManager: {
    getClient: () => null,
    isAvailable: false,
    status: 'degraded',
    get: async () => null,
    set: async () => false,
    del: async () => false,
  },
}));

// Mock logger to suppress output during tests
vi.mock('../../utils/logger.js', () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { createAuthMiddlewares } from '../auth';

// ─── Key Generation ──────────────────────────────────────────────────────────

// Generate a fresh RSA key pair for signing/verifying tokens in tests
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a mock Express Request with a JWT token in cookies */
function createMockReq(token: string) {
  return {
    cookies: { token },
    headers: {},
    originalUrl: '/api/v1/test',
  } as any;
}

/** Creates a mock Express Response that captures status and body */
function createMockRes() {
  let statusCode = 200;
  let body: any = null;

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      body = data;
      return res;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  } as any;

  let nextCalled = false;
  const next = () => { nextCalled = true; };
  const wasNextCalled = () => nextCalled;

  return { res, next, wasNextCalled };
}

/** Creates a valid JWT token signed with RS256 */
function createToken(payload: { id: string; username: string; role: string; session_version: number }) {
  return jwt.sign(payload, privateKey, { algorithm: 'RS256', expiresIn: '15m' });
}

/** Creates a mock DB that returns a user with a specified session_version */
function createMockDb(user: any) {
  return {
    prepare: () => ({
      get: async () => user,
    }),
  };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates a valid user ID (UUID-like string) */
const userIdArb = fc.uuid();

/** Generates a username */
const usernameArb = fc.stringMatching(/^[a-z][a-z0-9_]{3,15}$/);

/** Generates a user role */
const roleArb = fc.constantFrom('Admin', 'Auditor', 'Manager', 'Viewer');

/** Generates a session_version integer (positive) */
const sessionVersionArb = fc.integer({ min: 1, max: 1_000_000 });

/**
 * Generates a pair of mismatched session versions (dbVersion ≠ tokenVersion).
 * This is the core of Property 4: proving that ANY mismatch triggers 401.
 */
const mismatchedSessionVersionsArb = fc
  .tuple(sessionVersionArb, sessionVersionArb)
  .filter(([dbVersion, tokenVersion]) => dbVersion !== tokenVersion);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 4: Session Version Invalidation', () => {
  it('rejects with 401 when token session_version does not match DB session_version', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        usernameArb,
        roleArb,
        mismatchedSessionVersionsArb,
        async (userId, username, role, [dbSessionVersion, tokenSessionVersion]) => {
          // Create a valid token with a specific session_version
          const token = createToken({
            id: userId,
            username,
            role,
            session_version: tokenSessionVersion,
          });

          // Create a mock DB returning a user with a DIFFERENT session_version
          const mockDb = createMockDb({
            id: userId,
            username,
            name: username,
            email: `${username}@test.com`,
            role,
            status: 'Active',
            session_version: dbSessionVersion,
            requires_password_change: false,
            department_id: null,
          });

          // Create auth middleware with the test keys and mock DB
          const { authenticate } = createAuthMiddlewares(mockDb, 'unused-symmetric-key', publicKey);

          const req = createMockReq(token);
          const { res, next, wasNextCalled } = createMockRes();

          await authenticate(req, res, next);

          // The middleware MUST reject with 401 due to session version mismatch
          expect(res.getStatusCode()).toBe(401);
          expect(res.getBody().error).toBe('Session invalidated');
          expect(wasNextCalled()).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('allows request when token session_version matches DB session_version', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        usernameArb,
        roleArb,
        sessionVersionArb,
        async (userId, username, role, sessionVersion) => {
          // Same session_version in both token and DB
          const token = createToken({
            id: userId,
            username,
            role,
            session_version: sessionVersion,
          });

          const mockDb = createMockDb({
            id: userId,
            username,
            name: username,
            email: `${username}@test.com`,
            role,
            status: 'Active',
            session_version: sessionVersion,
            requires_password_change: false,
            department_id: null,
          });

          const { authenticate } = createAuthMiddlewares(mockDb, 'unused-symmetric-key', publicKey);

          const req = createMockReq(token);
          const { res, next, wasNextCalled } = createMockRes();

          await authenticate(req, res, next);

          // The middleware MUST allow the request (next() called)
          expect(wasNextCalled()).toBe(true);
          expect(res.getStatusCode()).toBe(200); // not overridden
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects even when token is otherwise valid (correct algorithm, not expired)', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        usernameArb,
        roleArb,
        mismatchedSessionVersionsArb,
        async (userId, username, role, [dbSessionVersion, tokenSessionVersion]) => {
          // Create a perfectly valid token (correct algorithm, not expired)
          const token = createToken({
            id: userId,
            username,
            role,
            session_version: tokenSessionVersion,
          });

          // Verify the token itself is valid (not expired, correct algorithm)
          const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as any;
          expect(decoded.id).toBe(userId);
          expect(decoded.session_version).toBe(tokenSessionVersion);

          // But the DB has a different session_version
          const mockDb = createMockDb({
            id: userId,
            username,
            name: username,
            email: `${username}@test.com`,
            role,
            status: 'Active',
            session_version: dbSessionVersion,
            requires_password_change: false,
            department_id: null,
          });

          const { authenticate } = createAuthMiddlewares(mockDb, 'unused-symmetric-key', publicKey);

          const req = createMockReq(token);
          const { res, next, wasNextCalled } = createMockRes();

          await authenticate(req, res, next);

          // Despite the token being fully valid, session version mismatch → 401
          expect(res.getStatusCode()).toBe(401);
          expect(res.getBody().error).toBe('Session invalidated');
          expect(wasNextCalled()).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
