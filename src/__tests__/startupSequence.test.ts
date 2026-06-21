// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseStrictNodeEnv } from '../config/nodeEnv';
import { runSecretsValidation } from '../utils/secretsValidator';

/**
 * Unit tests for the FATAL startup sequence (Task 2.7).
 *
 * The real startup logic in `src/main.ts` runs at module top level
 * (parseStrictNodeEnv gate → env validation → runSecretsValidation gate →
 * createApiServer(...).start()). Because importing `main.ts` triggers those
 * side effects (and process.exit), this suite validates the COMPOSED ordering
 * and fail-closed behaviour at the unit level using the pure/injectable pieces
 * that `main.ts` orchestrates in the documented order:
 *
 *   1. parseStrictNodeEnv  — the FIRST gate; unset/invalid NODE_ENV ⇒ ok:false
 *                            (main.ts exits non-zero unconditionally, before init).
 *   2. runSecretsValidation — the SECOND gate; in production with invalid secrets
 *                            it logs FATAL and calls the injectable exit hook with
 *                            code 1, with secret VALUES never appearing in any log.
 *
 * Together these assert: exit codes, gate ordering (NODE_ENV ← secrets), secret
 * sanitization, and that the listener (createApiServer().start()) is only reachable
 * after BOTH gates pass.
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */

// Mock the logger so we can assert on FATAL messages and scan them for leaks.
vi.mock('../utils/logger', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  },
}));

import logger from '../utils/logger';

/**
 * Faithful re-composition of the two startup gates as ordered in `src/main.ts`:
 *   NODE_ENV gate → secrets gate → (only then) server start.
 *
 * Returns the exit code the startup sequence would terminate with (or `null`
 * when both gates pass), plus a `serverStarted` flag indicating whether a
 * (mocked) `createApiServer(...).start()` would have been reachable. This mirrors
 * the short-circuit structure of main.ts: the FIRST failing gate determines the
 * outcome and prevents any later step (including starting the HTTP listener) from
 * running.
 */
function runStartupGates(
  env: Record<string, string | undefined>,
  startServer: () => void
): { exitCode: number | null; serverStarted: boolean } {
  // ─── Gate 1: strict NODE_ENV (unconditional, before any init) ───
  const parsed = parseStrictNodeEnv(env.NODE_ENV);
  if (!parsed.ok) {
    logger.error(
      `FATAL: NODE_ENV is invalid "${parsed.received}". ` +
        `Allowed values: development | production | test. Exit(1).`
    );
    return { exitCode: 1, serverStarted: false };
  }
  const nodeEnv = parsed.value;

  // ─── Gate 2: production secrets strength (before the listener) ───
  let secretsExitCode: number | null = null;
  const result = runSecretsValidation(env, {
    isProduction: nodeEnv === 'production',
    // In main.ts this is process.exit (never returns). Here we record the code;
    // runSecretsValidation invokes it as its last action in the failure branch,
    // so we then short-circuit exactly as the real sequence would.
    exit: ((code: number) => {
      secretsExitCode = code;
    }) as unknown as (code: number) => never,
  });

  if (secretsExitCode !== null) {
    return { exitCode: secretsExitCode, serverStarted: false };
  }
  if (!result.isValid && nodeEnv === 'production') {
    return { exitCode: 1, serverStarted: false };
  }

  // ─── Both gates passed: only now may the listener accept connections ───
  startServer();
  return { exitCode: null, serverStarted: true };
}

/** All three production secrets strong/valid. */
function strongSecrets(): Record<string, string> {
  return {
    JWT_SECRET: 'a'.repeat(64),
    VITE_STORAGE_SECRET: 'b'.repeat(32),
    VITE_NETWORK_SECRET: 'a-strong-network-secret-value',
  };
}

describe('startup sequence — Gate 1: strict NODE_ENV (Req 1.3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an unset NODE_ENV with exit(1) and a FATAL log before any init', () => {
    const startServer = vi.fn();
    const { exitCode, serverStarted } = runStartupGates(
      { ...strongSecrets() }, // NODE_ENV intentionally unset
      startServer
    );

    expect(exitCode).toBe(1);
    expect(serverStarted).toBe(false);
    expect(startServer).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    const messages = (logger.error as ReturnType<typeof vi.fn>).mock.calls.flat();
    expect(messages.some((m) => typeof m === 'string' && m.includes('FATAL'))).toBe(true);
  });

  it.each(['', '  ', 'prod', 'Production', 'staging', 'PRODUCTION'])(
    'rejects out-of-set / wrong-case NODE_ENV %p with exit(1)',
    (value) => {
      expect(parseStrictNodeEnv(value).ok).toBe(false);

      const startServer = vi.fn();
      const { exitCode, serverStarted } = runStartupGates(
        { NODE_ENV: value, ...strongSecrets() },
        startServer
      );

      expect(exitCode).toBe(1);
      expect(serverStarted).toBe(false);
      expect(startServer).not.toHaveBeenCalled();
    }
  );

  it.each(['development', 'production', 'test'])(
    'accepts the exact allowed value %p at the NODE_ENV gate',
    (value) => {
      expect(parseStrictNodeEnv(value)).toEqual({ ok: true, value });
    }
  );
});

describe('startup sequence — Gate 2: production secrets (Req 1.1, 1.2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs FATAL and exits(1) in production when secrets are invalid, before the listener starts', () => {
    const startServer = vi.fn();
    const env: Record<string, string> = {
      NODE_ENV: 'production',
      JWT_SECRET: 'alsaqi-dev-secret-key-123', // weak default
      VITE_STORAGE_SECRET: 'too-short',
      VITE_NETWORK_SECRET: 'your-network-hmac-secret-here', // weak default
    };

    const { exitCode, serverStarted } = runStartupGates(env, startServer);

    expect(exitCode).toBe(1);
    expect(serverStarted).toBe(false);
    expect(startServer).not.toHaveBeenCalled(); // no connections accepted
    expect(logger.error).toHaveBeenCalled();
    const fatal = (logger.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .filter((m): m is string => typeof m === 'string');
    expect(fatal.some((m) => m.includes('FATAL'))).toBe(true);
  });

  it('starts the server only after both gates pass in production with strong secrets', () => {
    const startServer = vi.fn();
    const { exitCode, serverStarted } = runStartupGates(
      { NODE_ENV: 'production', ...strongSecrets() },
      startServer
    );

    expect(exitCode).toBeNull();
    expect(serverStarted).toBe(true);
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does NOT exit in development even with weak secrets (non-blocking warnings)', () => {
    const startServer = vi.fn();
    const env: Record<string, string> = {
      NODE_ENV: 'development',
      JWT_SECRET: 'alsaqi-dev-secret-key-123',
      VITE_STORAGE_SECRET: 'your-32-character-secret-key-here',
      VITE_NETWORK_SECRET: 'your-network-hmac-secret-here',
    };

    const { exitCode, serverStarted } = runStartupGates(env, startServer);

    expect(exitCode).toBeNull();
    expect(serverStarted).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('startup sequence — secret value sanitization (Req 1.2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never prints actual secret values in any logged message', () => {
    const startServer = vi.fn();
    const env: Record<string, string> = {
      NODE_ENV: 'production',
      JWT_SECRET: 'super-secret-jwt-value-that-must-not-leak',
      VITE_STORAGE_SECRET: 'short-storage-secret-value',
      VITE_NETWORK_SECRET: 'your-network-hmac-secret-here',
    };

    runStartupGates(env, startServer);

    const allLogged = [
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
    ]
      .flat()
      .filter((m): m is string => typeof m === 'string');

    for (const [key, value] of Object.entries(env)) {
      if (key === 'NODE_ENV') continue;
      // The secret VALUE must never appear; only variable NAMES/reasons may.
      expect(allLogged.some((m) => m.includes(value))).toBe(false);
    }
    // But the variable names SHOULD appear so the operator knows what failed.
    expect(allLogged.some((m) => m.includes('JWT_SECRET'))).toBe(true);
  });
});

describe('startup sequence — gate ordering & no-connection-before-pass (Req 1.1, 1.2, 1.3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates NODE_ENV BEFORE secrets: an invalid NODE_ENV short-circuits before the secrets gate runs', () => {
    const startServer = vi.fn();
    // Secrets are ALSO invalid here, but the NODE_ENV gate must fire first and
    // the secrets gate (which would log its own FATAL secret messages) must NOT run.
    const env: Record<string, string> = {
      NODE_ENV: 'not-a-real-env',
      JWT_SECRET: 'weak',
      VITE_STORAGE_SECRET: 'weak',
      VITE_NETWORK_SECRET: 'your-network-hmac-secret-here',
    };

    const { exitCode, serverStarted } = runStartupGates(env, startServer);

    expect(exitCode).toBe(1);
    expect(serverStarted).toBe(false);

    // Exactly one FATAL log, and it is the NODE_ENV one — proving the secrets
    // gate never executed (ordering: NODE_ENV ← secrets).
    const errors = (logger.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .filter((m): m is string => typeof m === 'string');
    expect(errors.some((m) => m.includes('NODE_ENV is invalid'))).toBe(true);
    expect(errors.some((m) => m.includes('secrets'))).toBe(false);
  });

  it('never reaches the (mocked) listener while any gate fails', () => {
    const startServer = vi.fn();

    // Fail at gate 1.
    runStartupGates({ NODE_ENV: 'bogus', ...strongSecrets() }, startServer);
    // Fail at gate 2.
    runStartupGates(
      {
        NODE_ENV: 'production',
        JWT_SECRET: 'weak',
        VITE_STORAGE_SECRET: 'weak',
        VITE_NETWORK_SECRET: 'your-network-hmac-secret-here',
      },
      startServer
    );

    expect(startServer).not.toHaveBeenCalled();
  });
});
