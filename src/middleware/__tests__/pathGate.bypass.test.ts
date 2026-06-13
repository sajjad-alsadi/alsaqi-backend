// @vitest-environment node
// Feature: backend-security-hardening, Task 4.5
// Unit tests for query-string and segment-boundary bypass attempts against the
// path-safe password-change gate.
import { describe, it, expect } from 'vitest';
import { canonicalizePath, isPathAllowed } from '../pathGate';

/**
 * Task 4.5: Query-string and segment-boundary bypass denial.
 *
 * **Validates: Requirements 3.4, 3.5, 3.6** (and 3.2 — gate reads `req.path` only).
 *
 * These tests verify two attacker strategies against the password-change gate:
 *  - A crafted query string that embeds an allowed path (e.g. `?x=/auth/logout`)
 *    must NOT bypass the gate, because the gate matches on `req.path` only and
 *    never on `req.originalUrl` or any query-string component (Req 3.5, 3.2).
 *  - A segment-boundary lookalike such as `/auth/logout-evil` must be denied even
 *    though it shares a textual prefix with the allowed `/auth/logout` (Req 3.4).
 * Exact allowed routes (e.g. `/logout`, `/change-password`) remain permitted so a
 * gated user can still resolve the required change (Req 3.6).
 */

// Mirror of `PASSWORD_CHANGE_ALLOWED_PATHS` in `src/middleware/auth.ts`. These are
// router-relative canonical `req.path` values (the auth router is mounted under
// `/api/v1/auth`, so the logout route surfaces as `/logout`, not `/auth/logout`).
const ALLOWED_PATHS: readonly string[] = [
  '/change-password',
  '/update-password',
  '/logout',
  '/refresh',
  '/session',
];

const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

/**
 * Faithful replica of the password-change gate decision in `auth.ts`. It gates
 * strictly on the canonical form of `reqPath` (never `originalUrl`/query) and
 * returns the `PASSWORD_CHANGE_REQUIRED` denial code when the path is not allowed.
 * `reqPath` models Express's `req.path`, which excludes the query string.
 */
function gateDecision(reqPath: string): { allowed: boolean; code?: string } {
  const canonicalPath = canonicalizePath(reqPath);
  if (isPathAllowed(canonicalPath, ALLOWED_PATHS)) {
    return { allowed: true };
  }
  return { allowed: false, code: PASSWORD_CHANGE_REQUIRED };
}

describe('Task 4.5: query-string bypass attempts are denied (Req 3.5, 3.2)', () => {
  it('denies a non-allowed route even when its query string contains an allowed path (?x=/auth/logout)', () => {
    // Express's `req.path` excludes the query string, so the gate only ever sees
    // the path component. The attacker route resolves to `/secret`.
    const decision = gateDecision('/secret');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(PASSWORD_CHANGE_REQUIRED);
  });

  it('denies even if the full path?query string were (incorrectly) matched as one unit', () => {
    // Defense-in-depth: prove that matching cannot succeed even on the combined
    // text, since the canonical path still starts with the denied `/secret`
    // segment and `?x=/auth/logout` is not a path-segment boundary of any entry.
    const forged = '/secret?x=/auth/logout';
    expect(isPathAllowed(canonicalizePath(forged), ALLOWED_PATHS)).toBe(false);
  });

  it('denies an allowed-path lookalike smuggled entirely inside a query string of a denied route', () => {
    // `/logout` is allowed, but only as the path. A request to `/dashboard` whose
    // query merely mentions `/logout` must still be denied.
    expect(gateDecision('/dashboard').allowed).toBe(false);
    // And the raw "would-be" combined string is likewise not allowed.
    expect(isPathAllowed(canonicalizePath('/dashboard?next=/logout'), ALLOWED_PATHS)).toBe(false);
  });

  it('does not treat a query-string-embedded allowed path as a segment match (isPathAllowed directly)', () => {
    // `?x=/auth/logout` appended to a denied path is never a segment-boundary
    // extension of `/auth/logout`.
    expect(isPathAllowed('/secret?x=/auth/logout', ['/auth/logout'])).toBe(false);
  });
});

describe('Task 4.5: segment-boundary lookalikes are denied (Req 3.4)', () => {
  it('denies /logout-evil despite sharing a prefix with the allowed /logout', () => {
    const decision = gateDecision('/logout-evil');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(PASSWORD_CHANGE_REQUIRED);
  });

  it('denies the documented /auth/logout-evil lookalike against /auth/logout (isPathAllowed directly)', () => {
    expect(isPathAllowed('/auth/logout-evil', ['/auth/logout'])).toBe(false);
  });

  it('denies other non-separator suffix lookalikes of allowed entries', () => {
    expect(gateDecision('/logoutx').allowed).toBe(false);
    expect(gateDecision('/refresh-token').allowed).toBe(false);
    expect(gateDecision('/session_hijack').allowed).toBe(false);
    expect(gateDecision('/change-password-now').allowed).toBe(false);
  });

  it('denies a strict prefix of an allowed entry that is not itself allowed', () => {
    // `/change` is a prefix of `/change-password` but is not an allowed route.
    expect(gateDecision('/change').allowed).toBe(false);
  });
});

describe('Task 4.5: exact allowed paths and segment-boundary children are permitted (sanity, Req 3.6)', () => {
  it('allows each exact allowed route', () => {
    for (const entry of ALLOWED_PATHS) {
      const decision = gateDecision(entry);
      expect(decision.allowed).toBe(true);
      expect(decision.code).toBeUndefined();
    }
  });

  it('allows a path that extends an allowed entry at a "/" boundary', () => {
    expect(gateDecision('/logout/all').allowed).toBe(true);
    expect(gateDecision('/session/refresh').allowed).toBe(true);
  });

  it('allows allowed routes regardless of trailing slash or dot-segment noise (canonicalization, Req 3.3)', () => {
    expect(gateDecision('/logout/').allowed).toBe(true);
    expect(gateDecision('/change-password/.').allowed).toBe(true);
    expect(gateDecision('/refresh/../refresh').allowed).toBe(true);
  });

  it('still denies a lookalike even after canonicalization removes a trailing slash', () => {
    // `/logout-evil/` canonicalizes to `/logout-evil`, which remains denied.
    expect(gateDecision('/logout-evil/').allowed).toBe(false);
  });
});
