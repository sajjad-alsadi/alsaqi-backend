// @vitest-environment node
// Feature: backend-security-hardening, Property 2: Embedded-DB permission is independent of environment
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isEmbeddedDbAllowed } from '../poolConfig';

/**
 * Property Test for embedded-DB permission (Task 2.3)
 *
 * - Property 2: Embedded-DB permission is independent of environment
 *
 * For any combination of NODE_ENV and ALLOW_EMBEDDED_DB values,
 * `isEmbeddedDbAllowed` returns true if and only if ALLOW_EMBEDDED_DB is
 * exactly the string "true", regardless of NODE_ENV.
 *
 * **Validates: Requirements 1.2, 1.3**
 */

// Arbitrary NODE_ENV values, covering production, development, test, and
// arbitrary/absent values so the property exercises environment independence.
const nodeEnvArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constantFrom('production', 'development', 'test', 'staging'),
  fc.string(),
  fc.constant(undefined)
);

// Arbitrary ALLOW_EMBEDDED_DB values including the exact "true" string,
// near-miss variants (case, whitespace, truthy-looking strings) and absent.
const allowEmbeddedArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constantFrom('true', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'false', '0', ''),
  fc.string(),
  fc.constant(undefined)
);

function buildEnv(
  nodeEnv: string | undefined,
  allowEmbedded: string | undefined
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  if (allowEmbedded !== undefined) env.ALLOW_EMBEDDED_DB = allowEmbedded;
  return env;
}

describe('Property 2: Embedded-DB permission is independent of environment', () => {
  it('returns true iff ALLOW_EMBEDDED_DB === "true", regardless of NODE_ENV', () => {
    fc.assert(
      fc.property(nodeEnvArb, allowEmbeddedArb, (nodeEnv, allowEmbedded) => {
        const env = buildEnv(nodeEnv, allowEmbedded);
        const result = isEmbeddedDbAllowed(env);
        expect(result).toBe(allowEmbedded === 'true');
      }),
      { numRuns: 100 }
    );
  });

  it('permission for a fixed ALLOW_EMBEDDED_DB value does not change with NODE_ENV', () => {
    fc.assert(
      fc.property(allowEmbeddedArb, nodeEnvArb, nodeEnvArb, (allowEmbedded, envA, envB) => {
        const resultA = isEmbeddedDbAllowed(buildEnv(envA, allowEmbedded));
        const resultB = isEmbeddedDbAllowed(buildEnv(envB, allowEmbedded));
        // Independence: the result is the same across any two NODE_ENV values.
        expect(resultA).toBe(resultB);
      }),
      { numRuns: 100 }
    );
  });
});
