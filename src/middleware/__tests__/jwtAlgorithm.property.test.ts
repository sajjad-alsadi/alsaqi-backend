// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

/**
 * Property Test: JWT Algorithm Enforcement (Property 1)
 *
 * **Validates: Requirements 1.1, 1.2**
 *
 * For any JWT token presented to the authenticate middleware, the token SHALL be
 * accepted only if it is signed with the RS256 algorithm using the correct public
 * key; tokens signed with any other algorithm (HS256, RS384, none, etc.) or with
 * an invalid signature SHALL result in HTTP 401.
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

// Generate a fresh RSA key pair for the "server" (what the middleware trusts)
const { privateKey: serverPrivateKey, publicKey: serverPublicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Generate a second RSA key pair for "attacker" tokens (wrong key)
const { privateKey: attackerPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// A symmetric secret for HS256 algorithm confusion attacks
const hmacSecret = 'attacker-hmac-secret-key-for-testing-algorithm-confusion';

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

/** Creates a mock DB that returns a valid user */
function createMockDb(userId: string, sessionVersion: number) {
  return {
    prepare: () => ({
      get: async () => ({
        id: userId,
        username: 'testuser',
        name: 'Test User',
        email: 'test@example.com',
        role: 'Auditor',
        status: 'Active',
        session_version: sessionVersion,
        requires_password_change: false,
        department_id: null,
      }),
    }),
  };
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates a valid user ID */
const userIdArb = fc.uuid();

/** Generates a session version */
const sessionVersionArb = fc.integer({ min: 1, max: 1_000_000 });

/** Generates a non-RS256 algorithm that jwt library supports for signing */
const nonRS256AlgorithmArb = fc.constantFrom(
  'HS256' as const,
  'HS384' as const,
  'HS512' as const,
);

/** Generates a non-RS256 RSA/PS algorithm */
const nonRS256RsaAlgorithmArb = fc.constantFrom(
  'RS384' as const,
  'RS512' as const,
  'PS256' as const,
  'PS384' as const,
  'PS512' as const,
);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 1: JWT Algorithm Enforcement', () => {
  it('rejects tokens signed with HMAC algorithms (HS256, HS384, HS512) with 401', async () => {
    const { authenticate } = createAuthMiddlewares(
      createMockDb('any-id', 1),
      'unused-symmetric-key',
      serverPublicKey
    );

    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        sessionVersionArb,
        nonRS256AlgorithmArb,
        async (userId, sessionVersion, algorithm) => {
          // Sign a token with an HMAC algorithm (algorithm confusion attack)
          const token = jwt.sign(
            { id: userId, username: 'testuser', role: 'Auditor', session_version: sessionVersion },
            hmacSecret,
            { algorithm, expiresIn: '15m' }
          );

          const req = createMockReq(token);
          const { res, next, wasNextCalled } = createMockRes();

          await authenticate(req, res, next);

          // Must reject with 401 - wrong algorithm
          expect(res.getStatusCode()).toBe(401);
          expect(wasNextCalled()).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects tokens signed with non-RS256 RSA/PS algorithms (RS384, RS512, PS256, PS384, PS512) with 401', async () => {
    const { authenticate } = createAuthMiddlewares(
      createMockDb('any-id', 1),
      'unused-symmetric-key',
      serverPublicKey
    );

    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        sessionVersionArb,
        nonRS256RsaAlgorithmArb,
        async (userId, sessionVersion, algorithm) => {
          // Sign a token with a non-RS256 RSA algorithm using the correct private key
          // Even with the right key, wrong algorithm must be rejected
          const token = jwt.sign(
            { id: userId, username: 'testuser', role: 'Auditor', session_version: sessionVersion },
            serverPrivateKey,
            { algorithm, expiresIn: '15m' }
          );

          const req = createMockReq(token);
          const { res, next, wasNextCalled } = createMockRes();

          await authenticate(req, res, next);

          // Must reject with 401 - only RS256 is allowed
          expect(res.getStatusCode()).toBe(401);
          expect(wasNextCalled()).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects tokens signed with a different RSA private key (invalid signature) with 401', async () => {
    const { authenticate } = createAuthMiddlewares(
      createMockDb('any-id', 1),
      'unused-symmetric-key',
      serverPublicKey
    );

    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        sessionVersionArb,
        async (userId, sessionVersion) => {
          // Sign with RS256 but using the WRONG private key (attacker key)
          const token = jwt.sign(
            { id: userId, username: 'testuser', role: 'Auditor', session_version: sessionVersion },
            attackerPrivateKey,
            { algorithm: 'RS256', expiresIn: '15m' }
          );

          const req = createMockReq(token);
          const { res, next, wasNextCalled } = createMockRes();

          await authenticate(req, res, next);

          // Must reject with 401 - signature doesn't match the trusted public key
          expect(res.getStatusCode()).toBe(401);
          expect(wasNextCalled()).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('rejects tokens with "none" algorithm (unsigned tokens) with 401', async () => {
    const { authenticate } = createAuthMiddlewares(
      createMockDb('any-id', 1),
      'unused-symmetric-key',
      serverPublicKey
    );

    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        sessionVersionArb,
        async (userId, sessionVersion) => {
          // Craft a token with "none" algorithm (no signature)
          // jwt.sign won't allow algorithm: 'none' directly, so we craft it manually
          const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
          const payload = Buffer.from(JSON.stringify({
            id: userId,
            username: 'testuser',
            role: 'Auditor',
            session_version: sessionVersion,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 900,
          })).toString('base64url');

          // "none" algorithm means empty signature
          const token = `${header}.${payload}.`;

          const req = createMockReq(token);
          const { res, next, wasNextCalled } = createMockRes();

          await authenticate(req, res, next);

          // Must reject with 401 - "none" algorithm is not RS256
          expect(res.getStatusCode()).toBe(401);
          expect(wasNextCalled()).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('accepts tokens correctly signed with RS256 using the trusted private key', async () => {
    await fc.assert(
      fc.asyncProperty(
        userIdArb,
        sessionVersionArb,
        async (userId, sessionVersion) => {
          // Create a properly matching mock DB for this specific user
          const mockDb = createMockDb(userId, sessionVersion);
          const { authenticate } = createAuthMiddlewares(mockDb, 'unused-symmetric-key', serverPublicKey);

          // Sign with RS256 using the correct server private key
          const token = jwt.sign(
            { id: userId, username: 'testuser', role: 'Auditor', session_version: sessionVersion },
            serverPrivateKey,
            { algorithm: 'RS256', expiresIn: '15m' }
          );

          const req = createMockReq(token);
          const { res, next, wasNextCalled } = createMockRes();

          await authenticate(req, res, next);

          // Must accept - correct algorithm, correct key, matching session version
          expect(wasNextCalled()).toBe(true);
          expect(res.getStatusCode()).toBe(200); // not overridden by middleware
        }
      ),
      { numRuns: 100 }
    );
  });
});
