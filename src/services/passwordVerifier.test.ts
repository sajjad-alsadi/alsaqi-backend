/**
 * Smoke test asserting the login password-verification path performs only
 * asynchronous bcrypt comparison (`src/services/passwordVerifier.ts`).
 *
 * Spec: .kiro/specs/backend-security-hardening (task 8.2)
 *
 * Validates: Requirements 14.1
 *   WHEN the Auth_Service verifies a password, THE Auth_Service SHALL invoke the
 *   asynchronous bcrypt comparison and SHALL NOT invoke the synchronous bcrypt
 *   comparison.
 *
 * This is a static/smoke test: it reads the source of the password-verification
 * module and asserts that the synchronous `compareSync` API never appears in the
 * path, and confirms at runtime that `verifyPassword` returns an awaitable
 * Promise (i.e. it is async, not blocking).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import bcrypt from 'bcryptjs';
import { verifyPassword, DUMMY_HASH } from './passwordVerifier';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, 'passwordVerifier.ts');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

// Strip line and block comments so documentation references to "compareSync"
// (e.g. "never `bcrypt.compareSync`") do not cause false positives.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/[^\n]*/g, ''); // line comments
}

describe('passwordVerifier smoke test: no synchronous bcrypt in the login path', () => {
  const code = stripComments(SOURCE);

  it('does not reference the synchronous bcrypt comparison (compareSync)', () => {
    expect(code).not.toMatch(/compareSync/);
  });

  it('uses the asynchronous bcrypt.compare in the verification path', () => {
    expect(code).toMatch(/bcrypt\.compare\b/);
  });

  it('verifyPassword returns an awaitable Promise (async, non-blocking)', () => {
    const result = verifyPassword('any-plaintext', DUMMY_HASH);
    expect(result).toBeInstanceOf(Promise);
    return expect(result).resolves.toBe(false);
  });

  it('verifyPassword resolves true for a matching password', async () => {
    const plain = 'correct horse battery staple';
    const hash = await bcrypt.hash(plain, 4);
    await expect(verifyPassword(plain, hash)).resolves.toBe(true);
  });
});
