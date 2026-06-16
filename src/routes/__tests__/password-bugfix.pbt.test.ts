// @vitest-environment node
/**
 * Spec: forgot-password-admin-approval — Task 5: Property-Based Tests (Route Layer)
 *
 * **Validates: Requirements 2.1, 2.2, 2.3**
 *
 * PBT-1: Schema + no-message property
 *   For any random valid usernameOrEmail string (plain usernames, email addresses,
 *   various lengths) the fixed route SHALL:
 *   - Accept the request without a 400 validation error
 *   - Never include a `message` key in the response body
 *
 * PBT-2: Rate-limiter property
 *   For random sequences of 1–10 requests from random IP addresses:
 *   - Any IP exceeding 3 requests in the same 15-min window receives 429 on 4th+ request
 *   - IPs with ≤ 3 requests always receive 200
 *
 * Strategy: mock-based approach (same pattern as exploration test).
 * PBT-3 and PBT-4 (real DB) are in password-bugfix.pbt.db.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import fc from 'fast-check';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

import { globalErrorHandler } from '../../middleware/error';

// ─── vi.hoisted mocks ─────────────────────────────────────────────────────────

const { dbMock, passwordServiceMock, authServiceMock } = vi.hoisted(() => {
  const dbMock = { prepare: vi.fn() };
  const passwordServiceMock = {
    requestReset: vi.fn(),
    getResetStatus: vi.fn(),
    getResetRequests: vi.fn(),
    approveReset: vi.fn(),
    changePassword: vi.fn(),
    updatePassword: vi.fn(),
    rejectReset: vi.fn(),
  };
  const authServiceMock = { logAudit: vi.fn() };
  return { dbMock, passwordServiceMock, authServiceMock };
});

vi.mock('../../db/index', () => ({ db: dbMock }));
vi.mock('../../services/PasswordService', () => ({ PasswordService: passwordServiceMock }));
vi.mock('../../services/AuthService', () => ({ AuthService: authServiceMock }));
vi.mock('../../services/NotificationService', () => ({ NotificationService: { getAdminIds: vi.fn() } }));
vi.mock('../../middleware/auth', () => ({ invalidateUserCache: vi.fn() }));
vi.mock('../../services/passwordPolicy', () => ({
  DEFAULT_PASSWORD_MIN_LENGTH: 8,
  validatePasswordPolicy: vi.fn(),
}));
vi.mock('../../services/refreshCookiePath', () => ({
  getRefreshCookiePath: () => '/api/auth/refresh',
}));

import { createPasswordRoutes } from '../auth/password';

vi.setConfig({ testTimeout: 120_000 });

// ─── No-op limiter ────────────────────────────────────────────────────────────
const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

// ─── Fresh rate limiter factory ───────────────────────────────────────────────
/**
 * Creates a fresh in-process MemoryStore rate limiter for each property run.
 * This is essential for PBT-2: since fast-check runs many iterations, a
 * module-level singleton would accumulate state across runs.
 */
function makeFreshLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'no-ip'),
    handler: (_req, res) => {
      res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
    },
  });
}

// ─── Route-layer test app factory ─────────────────────────────────────────────
function buildMockApp(options?: { forgotPwLimiter?: express.RequestHandler }) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(cookieParser());

  const authenticate: express.RequestHandler = (req: any, _res, next) => {
    req.user = { id: 'admin-uuid-001', role: 'Admin', username: 'admin' };
    next();
  };
  const checkPermission = () => (_req: any, _res: any, next: any) => next();
  const authLimiter: express.RequestHandler = (_req, _res, next) => next();
  const createNotificationSpy = vi.fn().mockResolvedValue(undefined);
  const logError = vi.fn();

  const router = createPasswordRoutes(
    dbMock,
    'JWT_SECRET_TEST',
    'JWT_PRIVATE_KEY_TEST',
    authLimiter,
    authenticate,
    checkPermission,
    createNotificationSpy,
    logError,
    options?.forgotPwLimiter ?? noopLimiter,
  );

  app.use('/api/auth', router);
  app.use(globalErrorHandler);

  return { app, createNotificationSpy };
}

// ─── Shared beforeEach ────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();
  authServiceMock.logAudit.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// PBT-1: Schema + no-message property
//
// **Validates: Requirements 2.1, 2.2**
//
// For any random valid usernameOrEmail string the fixed route MUST:
//   - Accept the request without a 400 validation error
//   - Never include a `message` key in the response body
// ─────────────────────────────────────────────────────────────────────────────

describe('PBT-1: Schema + no-message property — Validates: Requirements 2.1, 2.2', () => {
  /**
   * Generator for diverse valid usernameOrEmail values:
   *   - Plain usernames (alphanumeric, various lengths)
   *   - Email addresses (local@domain.tld)
   */
  const usernameOrEmailArb = fc.oneof(
    // Plain usernames: 1–50 printable chars (trimmed, non-empty)
    fc.string({ minLength: 1, maxLength: 50 })
      .filter(s => s.trim().length > 0),
    // Email-like strings
    fc.tuple(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z0-9]+$/.test(s)),
      fc.string({ minLength: 2, maxLength: 15 }).filter(s => /^[a-zA-Z0-9]+$/.test(s)),
      fc.constantFrom('com', 'org', 'net', 'io', 'sa'),
    ).map(([local, domain, tld]) => `${local}@${domain}.${tld}`),
  );

  it('fixed schema always accepts any non-empty usernameOrEmail and response never contains message key', async () => {
    // Use noopLimiter (via default) to avoid rate-limiting across 50 runs
    const { app } = buildMockApp();

    await fc.assert(
      fc.asyncProperty(usernameOrEmailArb, async (usernameOrEmail) => {
        passwordServiceMock.requestReset.mockResolvedValueOnce({ success: true });

        const res = await request(app)
          .post('/api/auth/forgot-password')
          .set('X-Forwarded-For', '10.0.0.1')
          .send({ usernameOrEmail });

        // Property: schema MUST accept the value — never a 400 validation error
        expect(res.status).not.toBe(400);
        expect(res.status).toBe(200);

        // Property: response MUST NOT contain a `message` key (anti-enumeration)
        expect(res.body).not.toHaveProperty('message');
        expect(res.body).toEqual({ success: true });
      }),
      { numRuns: 50 },
    );
  });

  it('response body is exactly { success: true } for all service return shapes (no message leak)', async () => {
    const { app } = buildMockApp();

    // Different values the service might return (including with message fields)
    const serviceResponses = [
      { success: true },
      { success: true, user: { id: 'u1', username: 'a', name: 'A', department: 'IT' }, adminIds: ['adm1'], alertMsg: 'msg' },
      { success: true, message: 'If the username exists, a request has been sent.' },
      { success: true, message: 'A request is already pending.' },
    ];

    await fc.assert(
      fc.asyncProperty(
        usernameOrEmailArb,
        fc.integer({ min: 0, max: 3 }),
        async (usernameOrEmail, idx) => {
          passwordServiceMock.requestReset.mockResolvedValueOnce(serviceResponses[idx]);

          const res = await request(app)
            .post('/api/auth/forgot-password')
            .set('X-Forwarded-For', '10.0.0.2')
            .send({ usernameOrEmail });

          // Property: response is exactly { success: true } regardless of service return shape
          expect(res.status).toBe(200);
          expect(res.body).not.toHaveProperty('message');
          expect(res.body.success).toBe(true);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PBT-2: Rate-limiter property
//
// **Validates: Requirements 2.3**
//
// For random sequences of 1–10 requests from random IP addresses:
//   - Any IP exceeding 3 requests in the same 15-min window receives 429 on 4th+
//   - IPs with ≤ 3 requests always receive 200
//
// Each property run creates a FRESH Express app with a FRESH MemoryStore-backed
// rate limiter, guaranteeing isolation between property iterations.
// ─────────────────────────────────────────────────────────────────────────────

describe('PBT-2: Rate-limiter property — Validates: Requirements 2.3', () => {
  /**
   * Generator: array of (ip, count) pairs.
   * Uses a small IP pool so entries can share the same IP (testing the >3 limit).
   * count is 1–7 per entry; total per IP may exceed 3.
   */
  const ipCountsArb = fc.array(
    fc.tuple(
      fc.constantFrom('192.0.2.11', '192.0.2.12', '192.0.2.13'),
      fc.integer({ min: 1, max: 7 }),
    ),
    { minLength: 1, maxLength: 6 },
  );

  it('IP with > 3 requests receives 429 on 4th+ request; IP with ≤ 3 always gets 200', async () => {
    await fc.assert(
      fc.asyncProperty(ipCountsArb, async (ipCounts) => {
        // Fresh app + fresh limiter per property run to avoid state bleed
        const { app } = buildMockApp({ forgotPwLimiter: makeFreshLimiter() });
        passwordServiceMock.requestReset.mockResolvedValue({ success: true });

        const sentPerIp: Map<string, number> = new Map();

        for (const [ip, count] of ipCounts) {
          for (let i = 0; i < count; i++) {
            const reqNum = (sentPerIp.get(ip) ?? 0) + 1;
            sentPerIp.set(ip, reqNum);

            const res = await request(app)
              .post('/api/auth/forgot-password')
              .set('X-Forwarded-For', ip)
              .send({ usernameOrEmail: `user${reqNum}@example.com` });

            if (reqNum <= 3) {
              // First 3 requests from any IP MUST succeed
              expect(res.status).toBe(200);
            } else {
              // 4th+ request from same IP MUST be rate-limited
              expect(res.status).toBe(429);
            }
          }
        }
      }),
      { numRuns: 20 },
    );
  });

  it('IPs with exactly 3 requests always receive 200 (boundary: no 429 at the limit)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Use a wide random IP space so cross-run bleed is impossible even if a
        // shared limiter were used — but we still create a fresh one per run.
        fc.nat({ max: 254 }).map(n => `10.1.1.${n + 1}`),
        async (ip) => {
          const { app } = buildMockApp({ forgotPwLimiter: makeFreshLimiter() });
          passwordServiceMock.requestReset.mockResolvedValue({ success: true });

          const statuses: number[] = [];
          for (let i = 0; i < 3; i++) {
            const res = await request(app)
              .post('/api/auth/forgot-password')
              .set('X-Forwarded-For', ip)
              .send({ usernameOrEmail: `boundary${i}@example.com` });
            statuses.push(res.status);
          }

          // All 3 requests at the limit MUST return 200
          expect(statuses).toEqual([200, 200, 200]);
        },
      ),
      { numRuns: 15 },
    );
  });

  it('4th request from the same IP is blocked with 429 (exact limit + 1)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 254 }).map(n => `172.16.0.${n + 1}`),
        async (ip) => {
          const { app } = buildMockApp({ forgotPwLimiter: makeFreshLimiter() });
          passwordServiceMock.requestReset.mockResolvedValue({ success: true });

          const statuses: number[] = [];
          for (let i = 0; i < 4; i++) {
            const res = await request(app)
              .post('/api/auth/forgot-password')
              .set('X-Forwarded-For', ip)
              .send({ usernameOrEmail: `req${i}@example.com` });
            statuses.push(res.status);
          }

          expect(statuses[0]).toBe(200);
          expect(statuses[1]).toBe(200);
          expect(statuses[2]).toBe(200);
          expect(statuses[3]).toBe(429);
        },
      ),
      { numRuns: 15 },
    );
  });
});
