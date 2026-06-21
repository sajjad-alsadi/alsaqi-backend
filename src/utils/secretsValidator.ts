import logger from './logger';

/**
 * Reason a production-critical secret failed validation.
 * - `missing`     : the variable is unset or empty.
 * - `weak-default`: the variable matches a known weak/example default value.
 * - `too-short`   : the variable is shorter than the minimum required length.
 */
export type SecretFailureReason = 'weak-default' | 'too-short' | 'missing';

/** A single failed secret with the variable name and the reason it failed. */
export interface SecretFailure {
  variable: string;
  reason: SecretFailureReason;
}

/**
 * Result of production secrets validation.
 * `isValid` is true if and only if `failures` is empty.
 */
export interface SecretsValidationResult {
  isValid: boolean;
  failures: SecretFailure[];
}

/** Known weak default values that must be rejected in production. */
const WEAK_DEFAULTS: Record<string, readonly string[]> = {
  JWT_SECRET: ['alsaqi-dev-secret-key-123'],
  VITE_STORAGE_SECRET: ['your-32-character-secret-key-here'],
  VITE_NETWORK_SECRET: ['your-network-hmac-secret-here'],
};

/**
 * Strength rules for the three production-critical secrets, matching the rules
 * already enforced by Audit_Spec (`production-readiness-audit`):
 * - JWT_SECRET         : not a weak default, minimum 64 characters.
 * - VITE_STORAGE_SECRET: not a weak default, minimum 32 characters.
 * - VITE_NETWORK_SECRET: not a weak default (no minimum length in Audit_Spec).
 *
 * `minLength: 0` means no minimum-length rule applies.
 */
const SECRET_RULES: ReadonlyArray<{ variable: string; minLength: number }> = [
  { variable: 'JWT_SECRET', minLength: 64 },
  { variable: 'VITE_STORAGE_SECRET', minLength: 32 },
  { variable: 'VITE_NETWORK_SECRET', minLength: 0 },
];

/**
 * Evaluates a single secret against the weak-default and minimum-length rules.
 * Returns a `SecretFailure` describing the first failing rule, or `null` if the
 * secret passes. The order of precedence is: missing → weak-default → too-short.
 */
function evaluateSecret(
  variable: string,
  value: string | undefined,
  minLength: number
): SecretFailure | null {
  if (value === undefined || value.length === 0) {
    return { variable, reason: 'missing' };
  }
  if ((WEAK_DEFAULTS[variable] ?? []).includes(value)) {
    return { variable, reason: 'weak-default' };
  }
  if (minLength > 0 && value.length < minLength) {
    return { variable, reason: 'too-short' };
  }
  return null;
}

/**
 * PURE validator: evaluates `JWT_SECRET`, `VITE_STORAGE_SECRET`, and
 * `VITE_NETWORK_SECRET` against the Audit_Spec strength rules (rejecting weak
 * defaults and enforcing minimum lengths).
 *
 * `isValid` is `true` if and only if all three secrets pass their rules.
 *
 * This function has NO side effects: it never logs, never reads `process.env`
 * implicitly beyond the supplied default, and never terminates the process.
 * Effects (logging, process termination) live in {@link runSecretsValidation}.
 */
export function validateProductionSecrets(
  env: Record<string, string | undefined> = process.env
): SecretsValidationResult {
  const failures: SecretFailure[] = [];

  for (const rule of SECRET_RULES) {
    const failure = evaluateSecret(rule.variable, env[rule.variable], rule.minLength);
    if (failure) {
      failures.push(failure);
    }
  }

  return {
    isValid: failures.length === 0,
    failures,
  };
}

/**
 * Builds a human-readable, secret-safe message for a failure. The actual secret
 * value is NEVER included — only the variable name and the failure reason.
 */
function describeFailure(failure: SecretFailure): string {
  switch (failure.reason) {
    case 'missing':
      return `${failure.variable} must be set to a strong random value`;
    case 'weak-default':
      return `${failure.variable} must not use a known weak/default value`;
    case 'too-short':
      return `${failure.variable} does not meet the minimum required length`;
    default:
      return `${failure.variable} failed secrets validation`;
  }
}

/** Options controlling the effectful wrapper {@link runSecretsValidation}. */
export interface RunSecretsValidationOptions {
  /**
   * Whether the process is running in production. When omitted, it is derived
   * from `env.NODE_ENV === 'production'`.
   */
  isProduction?: boolean;
  /**
   * Process-termination hook, injectable for testing. Defaults to
   * `process.exit`. Invoked with code `1` in production when validation fails.
   */
  exit?: (code: number) => never;
}

/**
 * EFFECTFUL wrapper around {@link validateProductionSecrets}.
 *
 * In production, when secrets validation fails, it logs a single FATAL message
 * enumerating every failure (sanitized — secret values are never printed) and
 * terminates the process with a non-zero exit code before the HTTP listener can
 * accept connections.
 *
 * Outside production, failures are logged as non-blocking warnings and the
 * process is not terminated.
 *
 * Always returns the underlying validation result.
 */
export function runSecretsValidation(
  env: Record<string, string | undefined> = process.env,
  opts: RunSecretsValidationOptions = {}
): SecretsValidationResult {
  const result = validateProductionSecrets(env);
  const isProduction = opts.isProduction ?? env.NODE_ENV === 'production';
  const exit = opts.exit ?? ((code: number): never => process.exit(code));

  if (!result.isValid) {
    if (isProduction) {
      logger.error('FATAL: Production secrets validation failed:');
      result.failures.forEach((f) => logger.error(`  ✗ ${describeFailure(f)}`));
      exit(1);
    } else {
      logger.warn('Development mode - weak secrets detected (would fail in production):');
      result.failures.forEach((f) => logger.warn(`  ⚠ ${describeFailure(f)}`));
    }
  }

  return result;
}
