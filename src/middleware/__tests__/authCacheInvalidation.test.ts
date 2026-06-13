// @vitest-environment node
// Feature: backend-security-hardening, Task 8.16
//
// Unit/integration tests for auth cache invalidation and the auth rate-limit window.
//
// Covers:
//   - Req 16.1, 16.2, 16.3: invalidation takes effect immediately (within 1s) and the
//     next authenticate() re-reads fresh from the authoritative store (cache bypassed).
//   - Req 16.4: when Redis invalidation fails all 3 attempts, the user is flagged for a
//     forced authoritative re-read; the next authenticate() forces a DB read and clears
//     the flag on success.
//   - Req 16.5: when the authoritative store is unreachable during a forced re-read,
//     authenticate() denies with 503 AUTH_STATE_UNVERIFIABLE rather than serving stale.
//   - Req 18.2, 18.3, 18.4: the authLimiter blocks over-limit attempts with the number of
//     seconds remaining, without evaluating credentials, and its window/limit are sourced
//     from configuration. Window-reset accounting is exercised with fake timers.
//
// Approach notes:
//   - We use a stateful in-memory fake of `redisManager` (and its underlying client) so we
//     can observe cache writes from authenticate(), deletions from invalidate(), and inject
//     deletion failures to drive the force-read path.
//   - The authoritative store is a mock `db.prepare(...).get()` whose returned row (and
//     reachability) we mutate between requests.
//   - express-rate-limit is mocked so we can capture the options passed to rateLimit()
//     (windowMs, max, keyGenerator, handler) and invoke the handler directly. The real
//     rolling-window counter reset is internal to express-rate-limit and is driven by
//     `windowMs`; we therefore assert windowMs/max equal the configured values and verify
//     the handler's seconds-remaining countdown toward the reset time using fake timers.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ─── Stateful Redis fake (shared with the modules under test) ────────────────

const hoisted = vi.hoisted(() => {
  const store = new Map<string, string>();
  const state = { available: true, failDel: false };

  /** Convert a Redis glob (only `*` wildcard used here) to an anchored RegExp. */
  const globToRegExp = (glob: string): RegExp => {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  };

  const client = {
    // Signature mirrors the call in AuthCacheInvalidator: scan(cursor, 'MATCH', pattern, 'COUNT', n)
    async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
      const re = globToRegExp(pattern);
      const keys = [...store.keys()].filter((k) => re.test(k));
      return ['0', keys];
    },
    async del(...keys: string[]): Promise<number> {
      if (state.failDel) throw new Error('redis DEL failed (simulated)');
      let deleted = 0;
      for (const k of keys) {
        if (store.delete(k)) deleted++;
      }
      return deleted;
    },
  };

  const redisManager = {
    get isAvailable(): boolean {
      return state.available;
    },
    getClient: () => (state.available ? client : null),
    async get(key: string): Promise<string | null> {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async set(key: string, value: string): Promise<boolean> {
      store.set(key, value);
      return true;
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
    status: 'ready',
  };

  return { store, state, client, redisManager };
});

const rl = vi.hoisted(() => ({ captured: null as any }));

vi.mock('../../cache/redisManager.js', () => ({ redisManager: hoisted.redisManager }));

vi.mock('express-rate-limit', () => ({
  rateLimit: (options: any) => {
    rl.captured = options;
    // Return a no-op middleware; authenticate() does not invoke authLimiter directly.
    return (_req: any, _res: any, next: any) => next();
  },
}));

vi.mock('../../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { createAuthMiddlewares } from '../auth';
import { AuthCacheInvalidator } from '../../services/AuthCacheInvalidator';
import { getAuthRateLimitMax, getAuthRateLimitWindowS } from '../../config/environmentConfig.js';

// ─── Test keys ───────────────────────────────────────────────────────────────

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ─── Helpers ───────────────────────────────────────────────────────────────

const USER_ID = '11111111-1111-4111-8111-111111111111';
const USERNAME = 'alice';
const ROLE = 'Auditor';
const SESSION_VERSION = 1;

function activeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    role: ROLE,
    status: 'Active',
    username: USERNAME,
    name: 'Alice',
    email: 'alice@test.com',
    session_version: SESSION_VERSION,
    requires_password_change: false,
    department_id: null,
    ...overrides,
  };
}

interface DbState {
  user: any;
  throws: boolean;
}

/** Authoritative-store mock whose returned row and reachability are mutable. */
function createMockDb(dbState: DbState) {
  return {
    prepare: () => ({
      get: async () => {
        if (dbState.throws) {
          throw new Error('ECONNREFUSED: authoritative store unreachable (simulated)');
        }
        return dbState.user;
      },
    }),
  };
}

function createToken(sessionVersion = SESSION_VERSION) {
  return jwt.sign(
    { id: USER_ID, username: USERNAME, role: ROLE, session_version: sessionVersion },
    privateKey,
    { algorithm: 'RS256', expiresIn: '15m' },
  );
}

function createMockReq(token: string) {
  return { cookies: { token }, headers: {}, originalUrl: '/api/v1/resource', path: '/resource' } as any;
}

function createMockRes() {
  let statusCode = 200;
  let body: any = null;
  const headers: Record<string, string> = {};
  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      body = data;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
    getHeaders: () => headers,
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  const wasNextCalled = () => nextCalled;
  return { res, next, wasNextCalled };
}

const cacheKey = (sv = SESSION_VERSION) => `auth:user_${USER_ID}_${sv}`;

beforeEach(() => {
  hoisted.store.clear();
  hoisted.state.available = true;
  hoisted.state.failDel = false;
  AuthCacheInvalidator._reset();
});

// ─── Cache invalidation (Req 16.1–16.5) ──────────────────────────────────────

describe('Auth cache invalidation (Req 16)', () => {
  it('invalidation takes effect immediately: next authenticate re-reads fresh, cache bypassed (Req 16.1, 16.2, 16.3)', async () => {
    const dbState: DbState = { user: activeUser(), throws: false };
    const { authenticate } = createAuthMiddlewares(createMockDb(dbState), 'unused', publicKey);
    const token = createToken();

    // 1st request populates the distributed cache and is allowed.
    let r = createMockRes();
    await authenticate(createMockReq(token), r.res, r.next);
    expect(r.wasNextCalled()).toBe(true);
    expect(hoisted.store.has(cacheKey())).toBe(true);

    // Authoritative store changes: the account is suspended.
    dbState.user = activeUser({ status: 'Suspended' });

    // Without invalidation the stale cached "Active" value would still be served.
    r = createMockRes();
    await authenticate(createMockReq(token), r.res, r.next);
    expect(r.wasNextCalled()).toBe(true); // confirms the stale value is what got served pre-invalidation

    // Invalidate — must complete (and take effect) well within 1 second (Req 16.1).
    const start = Date.now();
    await AuthCacheInvalidator.invalidate(USER_ID);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);

    // The cached entry is gone, so the next read goes to the authoritative store.
    expect(hoisted.store.has(cacheKey())).toBe(false);

    // Next request re-reads fresh → sees Suspended → denied (Req 16.3).
    r = createMockRes();
    await authenticate(createMockReq(token), r.res, r.next);
    expect(r.res.getStatusCode()).toBe(403);
    expect(r.wasNextCalled()).toBe(false);
  });

  it('forces an authoritative re-read after 3 failed Redis invalidations and clears the flag on success (Req 16.4)', async () => {
    // A stale "Active" entry exists; every Redis DEL attempt fails.
    hoisted.store.set(cacheKey(), JSON.stringify(activeUser()));
    hoisted.state.failDel = true;

    await AuthCacheInvalidator.invalidate(USER_ID);

    // All 3 attempts failed → user flagged for a forced authoritative re-read.
    expect(AuthCacheInvalidator.shouldForceRead(USER_ID)).toBe(true);
    // The stale entry could not be deleted, so it is still present.
    expect(hoisted.store.has(cacheKey())).toBe(true);

    // Authoritative store now reflects the suspension.
    const dbState: DbState = { user: activeUser({ status: 'Suspended' }), throws: false };
    const { authenticate } = createAuthMiddlewares(createMockDb(dbState), 'unused', publicKey);

    const r = createMockRes();
    await authenticate(createMockReq(createToken()), r.res, r.next);

    // The forced re-read bypassed the stale "Active" cache and saw "Suspended".
    expect(r.res.getStatusCode()).toBe(403);
    expect(r.wasNextCalled()).toBe(false);
    // A successful authoritative read clears the forced-re-read flag (Req 16.4).
    expect(AuthCacheInvalidator.shouldForceRead(USER_ID)).toBe(false);
  });

  it('denies with 503 AUTH_STATE_UNVERIFIABLE when the store is unreachable during a forced re-read (Req 16.5)', async () => {
    // Drive the force-read state: stale entry present, all DELs fail.
    hoisted.store.set(cacheKey(), JSON.stringify(activeUser()));
    hoisted.state.failDel = true;
    await AuthCacheInvalidator.invalidate(USER_ID);
    expect(AuthCacheInvalidator.shouldForceRead(USER_ID)).toBe(true);

    // The authoritative store is now unreachable.
    const dbState: DbState = { user: null, throws: true };
    const { authenticate } = createAuthMiddlewares(createMockDb(dbState), 'unused', publicKey);

    const r = createMockRes();
    await authenticate(createMockReq(createToken()), r.res, r.next);

    // Denied rather than serving the stale cached "Active" value (Req 16.5).
    expect(r.res.getStatusCode()).toBe(503);
    expect(r.res.getBody().code).toBe('AUTH_STATE_UNVERIFIABLE');
    expect(r.wasNextCalled()).toBe(false);
    // The flag remains set because no successful authoritative read occurred.
    expect(AuthCacheInvalidator.shouldForceRead(USER_ID)).toBe(true);
  });

  it('treats invalidation as successful (no force-read) when Redis is unavailable, since auth reads straight from the store (Req 16.3)', async () => {
    hoisted.state.available = false;
    await AuthCacheInvalidator.invalidate(USER_ID);
    expect(AuthCacheInvalidator.shouldForceRead(USER_ID)).toBe(false);
  });
});

// ─── Rate limiting window/limit (Req 18.2, 18.3, 18.4) ───────────────────────

describe('Auth rate limiting (Req 18)', () => {
  function buildLimiter() {
    rl.captured = null;
    createAuthMiddlewares(createMockDb({ user: null, throws: false }), 'unused', publicKey);
    expect(rl.captured).not.toBeNull();
    return rl.captured;
  }

  it('sources the window and limit from configuration (Req 18.2)', () => {
    const opts = buildLimiter();
    expect(opts.windowMs).toBe(getAuthRateLimitWindowS() * 1000);
    expect(opts.max).toBe(getAuthRateLimitMax());
  });

  it('reflects overridden configuration values for window and limit (Req 18.2)', () => {
    const prevMax = process.env.AUTH_RATE_LIMIT_MAX;
    const prevWin = process.env.AUTH_RATE_LIMIT_WINDOW_S;
    process.env.AUTH_RATE_LIMIT_MAX = '5';
    process.env.AUTH_RATE_LIMIT_WINDOW_S = '120';
    try {
      const opts = buildLimiter();
      expect(opts.max).toBe(5);
      expect(opts.windowMs).toBe(120 * 1000);
    } finally {
      if (prevMax === undefined) delete process.env.AUTH_RATE_LIMIT_MAX;
      else process.env.AUTH_RATE_LIMIT_MAX = prevMax;
      if (prevWin === undefined) delete process.env.AUTH_RATE_LIMIT_WINDOW_S;
      else process.env.AUTH_RATE_LIMIT_WINDOW_S = prevWin;
    }
  });

  it('blocks over-limit attempts with 429 and seconds remaining, without evaluating credentials (Req 18.2, 18.3)', () => {
    const opts = buildLimiter();
    expect(typeof opts.handler).toBe('function');

    // Simulate an over-limit attempt: express-rate-limit invokes the handler instead
    // of the login route, so credentials are never evaluated. resetTime is ~300s out.
    const resetTime = new Date(Date.now() + 300 * 1000);
    const { res } = createMockRes();
    opts.handler({ ip: '203.0.113.7', rateLimit: { resetTime } }, res);

    expect(res.getStatusCode()).toBe(429);
    expect(res.getBody().error).toBe('TOO_MANY_ATTEMPTS');
    expect(res.getBody().retryAfterSeconds).toBeGreaterThan(0);
    expect(res.getBody().retryAfterSeconds).toBeLessThanOrEqual(300);
    expect(res.getHeaders()['Retry-After']).toBe(String(res.getBody().retryAfterSeconds));
  });

  it('counts down seconds-remaining toward the window reset (Req 18.3, 18.4)', () => {
    const opts = buildLimiter();
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);
      const windowS = getAuthRateLimitWindowS();
      const resetTime = new Date(now + windowS * 1000);

      // Immediately after blocking, ~full window remains.
      let { res } = createMockRes();
      opts.handler({ rateLimit: { resetTime } }, res);
      const initialRemaining = res.getBody().retryAfterSeconds;
      expect(initialRemaining).toBeGreaterThanOrEqual(windowS - 1);
      expect(initialRemaining).toBeLessThanOrEqual(windowS);

      // Advance time partway through the window; the reported remaining time shrinks.
      vi.advanceTimersByTime(100 * 1000);
      ({ res } = createMockRes());
      opts.handler({ rateLimit: { resetTime } }, res);
      const laterRemaining = res.getBody().retryAfterSeconds;
      expect(laterRemaining).toBeLessThan(initialRemaining);
      expect(laterRemaining).toBeCloseTo(windowS - 100, -1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the configured window for seconds-remaining when no resetTime is available (Req 18.4)', () => {
    const opts = buildLimiter();
    const { res } = createMockRes();
    // No rateLimit.resetTime → the handler reports the full configured window.
    opts.handler({}, res);
    expect(res.getStatusCode()).toBe(429);
    expect(res.getBody().retryAfterSeconds).toBe(getAuthRateLimitWindowS());
  });
});
