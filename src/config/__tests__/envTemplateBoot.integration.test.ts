// @vitest-environment node
// Feature: production-launch-readiness, Task 3.4
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ENV_VAR_DEFINITIONS,
  validateEnvironment,
  validateEnvironmentOnStartup,
  type EnvVarDefinition,
} from '../envValidator.js';

/**
 * Integration Test: Booting the environment from the production template (Task 3.4)
 *
 * Feature: production-launch-readiness
 *
 * **Validates: Requirements 2.3**
 *
 * Requirement 2.3 states: WHEN a config file is created by copying Env_Template and
 * assigning a value to every `[REQUIRED]` variable that satisfies the type and
 * minimum-length rule defined for that variable in `ENV_VAR_DEFINITIONS`, THE
 * Startup_Sequence SHALL complete startup environment validation with ZERO errors
 * and proceed to accept connections — without logging a FATAL error about a missing
 * or invalid required secret and WITHOUT relying on any fallback value (e.g.
 * `FILE_ACCESS_SECRET` must be set explicitly, not falling back to `JWT_SECRET`).
 *
 * This test:
 *   1. Parses `.env.production.example` to discover which variables are tagged `[REQUIRED]`.
 *   2. Builds an env object assigning a VALID value to every required variable,
 *      satisfying its type + minLength rules from `ENV_VAR_DEFINITIONS`.
 *   3. Runs the environment validator in production mode and asserts ZERO errors.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/config/__tests__ -> repo root
const TEMPLATE_PATH = resolve(__dirname, '../../../.env.production.example');

// ─── Template parsing ──────────────────────────────────────────────────────────

/**
 * Parses the production template and returns the set of variable names that are
 * documented with the `[REQUIRED]` tag. The tag appears in a comment block above
 * the `NAME=value` assignment, so we track the most recent tag seen.
 */
function parseRequiredFromTemplate(contents: string): Set<string> {
  const required = new Set<string>();
  let lastTag: 'REQUIRED' | 'OPTIONAL' | null = null;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) {
      if (line.includes('[REQUIRED]')) {
        lastTag = 'REQUIRED';
      } else if (line.includes('[OPTIONAL]')) {
        lastTag = 'OPTIONAL';
      }
      continue;
    }

    // Assignment line: NAME=value
    const match = line.match(/^([A-Z0-9_]+)\s*=/);
    if (match) {
      if (lastTag === 'REQUIRED') {
        required.add(match[1]);
      }
      // Reset tag so a tag only applies to the immediately following assignment.
      lastTag = null;
    }
  }

  return required;
}

// ─── Valid value generation ─────────────────────────────────────────────────────

/**
 * Produces a VALID value for a given definition that satisfies its type rule and
 * minimum-length rule, so the validator should accept it with zero errors.
 */
function validValueFor(def: EnvVarDefinition): string {
  const padTo = (base: string, min?: number): string => {
    if (!min || base.length >= min) return base;
    return base + 'x'.repeat(min - base.length);
  };

  switch (def.type) {
    case 'numeric':
      return '3000';
    case 'boolean':
      return 'true';
    case 'path':
      return '/app/data';
    case 'log-level':
      return 'info';
    case 'pem-key':
      return '-----BEGIN RSA PRIVATE KEY-----\\nMIIabc\\n-----END RSA PRIVATE KEY-----';
    case 'url':
      if (def.name === 'DATABASE_URL') {
        return 'postgresql://user:pass@db.example.com:5432/alsaqi_production';
      }
      if (def.name === 'REDIS_URL') {
        return 'redis://redis.example.com:6379';
      }
      return 'https://example.com/webhook';
    case 'string':
    default: {
      // CORS_ORIGIN is a comma-separated URL list, but validated only as non-empty string.
      const base = `valid-${def.name.toLowerCase()}-value`;
      return padTo(base, def.minLength);
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Env template boot integration (Requirement 2.3)', () => {
  const templateContents = readFileSync(TEMPLATE_PATH, 'utf8');
  const requiredFromTemplate = parseRequiredFromTemplate(templateContents);
  const requiredFromDefs = ENV_VAR_DEFINITIONS.filter((d) => d.required).map((d) => d.name);

  it('template [REQUIRED] tags cover every production-required definition', () => {
    // Sanity check: the template documents each ENV_VAR_DEFINITIONS required var as [REQUIRED].
    for (const name of requiredFromDefs) {
      expect(requiredFromTemplate.has(name)).toBe(true);
    }
  });

  it('a config built from the template (every [REQUIRED] set to a valid value) validates with ZERO errors', () => {
    const env: Record<string, string> = { NODE_ENV: 'production' };

    // Assign a valid value for every variable tagged [REQUIRED] in the template.
    for (const def of ENV_VAR_DEFINITIONS) {
      if (requiredFromTemplate.has(def.name)) {
        env[def.name] = validValueFor(def);
      }
    }

    const result = validateEnvironment(env, true);

    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it('does not rely on a JWT_SECRET fallback for FILE_ACCESS_SECRET', () => {
    // Build a valid env but OMIT FILE_ACCESS_SECRET. Even though JWT_SECRET is present,
    // the validator must flag FILE_ACCESS_SECRET as missing (no fallback allowed).
    const env: Record<string, string> = { NODE_ENV: 'production' };
    for (const def of ENV_VAR_DEFINITIONS) {
      if (requiredFromTemplate.has(def.name) && def.name !== 'FILE_ACCESS_SECRET') {
        env[def.name] = validValueFor(def);
      }
    }

    const result = validateEnvironment(env, true);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.variable === 'FILE_ACCESS_SECRET')).toBe(true);
  });

  it('validateEnvironmentOnStartup reports zero errors for a template-derived production config', () => {
    const env: Record<string, string> = { NODE_ENV: 'production' };
    for (const def of ENV_VAR_DEFINITIONS) {
      if (requiredFromTemplate.has(def.name)) {
        env[def.name] = validValueFor(def);
      }
    }

    const result = validateEnvironmentOnStartup(env);

    expect(result.errors).toEqual([]);
    expect(result.isValid).toBe(true);
  });
});
