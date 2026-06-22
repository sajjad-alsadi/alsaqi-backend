// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { RegisterSchema } from '@alsaqi/shared';

/**
 * Property Test: register authorization invariance
 *
 * Feature: backend-api-contract-alignment, Property 10: no user created unless
 * authenticated + permitted + valid body
 *
 * **Validates: Requirements 8.2, 8.3, 8.7**
 *
 * The admin-guarded `POST /auth/register` route (`createRegisterRoutes`) is
 * guarded by `authenticate` → `checkPermission('UserManagement','Create')` →
 * `validateBody(RegisterSchema)` before reaching the handler that calls
 * `UserService.createUser`.
 *
 * Property: for any randomized combination of authentication pass/fail,
 * permission pass/fail, and valid/invalid RegisterInput body, no user is
 * created (UserService.createUser is NOT called) whenever ANY guard or the
 * body validation fails — and in that case the HTTP status is within
 * {401, 403, 400}. Only when authentication passes AND permission passes AND
 * the body is valid is UserService.createUser invoked (status 201).
 */

// ─── Mock the single user-creation path and the audit logger ─────────────────
vi.mock('../../../services/UserService', () => ({
  UserService: {
    createUser: vi.fn(),
  },
}));

vi.mock('../../../services/AuthService', () => ({
  AuthService: {
    logAudit: vi.fn(),
  },
}));

import { UserService } from '../../../services/UserService';
import { AuthService } from '../../../services/AuthService';
import { createRegisterRoutes } from '../register';

// ─── Mutable guard state, read by the stubbed middleware per request ─────────
const guardState = { authPass: true, permPass: true };

function createTestApp() {
  const app = express();
  app.use(express.json());

  // Stubbed authenticate: pass/fail based on the randomized guard state.
  const authenticate = (req: any, res: any, next: any) => {
    if (!guardState.authPass) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    }
    req.user = { id: 'admin-1', username: 'admin', role: 'Admin' };
    next();
  };

  // Stubbed checkPermission factory: pass/fail based on the randomized state.
  const checkPermission = (_module: string, _action: string) => (req: any, res: any, next: any) => {
    if (!guardState.permPass) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    }
    next();
  };

  const db = {};
  const logError = vi.fn();

  app.use('/auth', createRegisterRoutes(db, authenticate, checkPermission, logError));
  return app;
}

// ─── Body generators ──────────────────────────────────────────────────────────

// A body that satisfies RegisterSchema.
const validBodyArb = fc.record({
  username: fc.string({ minLength: 3, maxLength: 50 }),
  password: fc.string({ minLength: 6, maxLength: 100 }),
  name: fc.string({ minLength: 1, maxLength: 100 }),
  email: fc
    .tuple(fc.string({ minLength: 1, maxLength: 10 }), fc.constantFrom('example.com', 'test.org', 'mail.co'))
    .map(([raw, domain]) => `${raw.replace(/[^a-zA-Z0-9]/g, '') || 'user'}@${domain}`),
  role: fc.string({ minLength: 1, maxLength: 50 }),
});

// Arbitrary junk bodies — most fail RegisterSchema validation.
const junkBodyArb = fc.oneof(
  fc.constant({}),
  fc.record({ username: fc.string({ maxLength: 2 }) }),
  fc.record({ email: fc.string() }),
  fc.dictionary(fc.string(), fc.anything()),
);

const bodyArb = fc.oneof(validBodyArb, junkBodyArb);

// ─── Test ──────────────────────────────────────────────────────────────────────

describe('Property 10: register authorization invariance (no user created unless authenticated + permitted + valid body)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(UserService.createUser).mockResolvedValue({
      id: 'new-user-1',
      username: 'created',
      role: 'Auditor',
    } as any);
    vi.mocked(AuthService.logAudit).mockResolvedValue(undefined as any);
    app = createTestApp();
  });

  it('only creates a user when authentication, permission, and body validation all pass', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), bodyArb, async (authPass, permPass, body) => {
        guardState.authPass = authPass;
        guardState.permPass = permPass;
        vi.mocked(UserService.createUser).mockClear();

        const bodyValid = RegisterSchema.safeParse(body).success;
        const shouldCreate = authPass && permPass && bodyValid;

        const res = await request(app).post('/auth/register').send(body);

        const createUserCalled = vi.mocked(UserService.createUser).mock.calls.length > 0;

        if (shouldCreate) {
          // All guards passed and the body is valid → user IS created (201).
          expect(createUserCalled).toBe(true);
          expect(res.status).toBe(201);
        } else {
          // Any guard or validation failure → NO user created, status in {401,403,400}.
          expect(createUserCalled).toBe(false);
          expect([401, 403, 400]).toContain(res.status);
        }
      }),
      { numRuns: 100 },
    );
  });
});
