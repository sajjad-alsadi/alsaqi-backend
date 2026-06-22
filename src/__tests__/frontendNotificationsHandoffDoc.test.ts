/**
 * Presence / enumeration assertion for the frontend notifications contract
 * handoff document (Requirement 13, verified via R7.12).
 *
 * R11/R12/R13 carry no property-based tests by design; the handoff doc (R13)
 * is verified by this documentation presence/enumeration check. It asserts the
 * doc exists on disk and enumerates the four contract changes it must cover:
 *   - `PUT /notifications/mark-all-read`   (R13.2)
 *   - `GET /notifications`                 (R13.3)
 *   - `PUT /notifications/mark-read`        (R13.4)
 *   - `POST /auth/register`                (R13.5)
 *
 * **Validates: Requirements 7.12**
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// From src/__tests__/ → backend package root is two levels up.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANDOFF_DOC = resolve(PACKAGE_ROOT, 'docs', 'frontend-notifications-contract-handoff.md');

describe('frontend notifications contract handoff doc (Req 7.12, R13)', () => {
  it('exists on disk', () => {
    expect(
      existsSync(HANDOFF_DOC),
      `Expected handoff doc at ${HANDOFF_DOC}`
    ).toBe(true);
  });

  it('enumerates the four contract changes', () => {
    const contents = readFileSync(HANDOFF_DOC, 'utf-8');
    const required = ['mark-all-read', 'GET /notifications', 'mark-read', 'POST /auth/register'];

    for (const token of required) {
      expect(
        contents.includes(token),
        `Handoff doc must mention "${token}"`
      ).toBe(true);
    }
  });
});
