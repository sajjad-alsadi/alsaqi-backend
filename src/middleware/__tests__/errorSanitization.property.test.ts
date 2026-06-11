// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { sanitizeErrorMessage } from '../error';

/**
 * Property Test: Error Message Sanitization (Property 10)
 *
 * **Validates: Requirements 6.3, 10.1, 16.2, 16.3**
 *
 * For any error message containing SQL keywords (SELECT, INSERT, etc.),
 * file paths (e.g., `/app/src/file.ts`), stack traces (e.g., `at Function.run (/app/...)`),
 * known table names, or internal service names, the `sanitizeErrorMessage` function SHALL
 * return a string that does not contain any of those patterns.
 */

// ─── Constants matching the implementation ───────────────────────────────────

const SQL_KEYWORDS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'JOIN',
  'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY',
  'HAVING', 'LIMIT', 'OFFSET', 'CREATE', 'ALTER', 'DROP', 'INDEX',
  'CONSTRAINT', 'UNIQUE', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES',
  'ON DELETE', 'ON UPDATE', 'CASCADE', 'SET NULL', 'RETURNING', 'VALUES', 'INTO',
];

const TABLE_NAMES = [
  'audit_tasks', 'audit_programs', 'audit_findings', 'audit_plans',
  'recommendations', 'users', 'departments', 'roles', 'permissions',
  'notifications', 'correspondence', 'attachments', 'comments',
  'policies', 'compliance', 'fraud', 'integrity', 'coi',
  'org_entities', 'job_titles', 'sessions', 'settings', 'app_settings',
  'request_logs', 'file_access_logs', 'idempotency_keys',
  'dead_letter_queue', 'regulatory', 'executive_reports',
  'pdf_templates', 'risk_assessments',
];

const INTERNAL_SERVICES = [
  'BaseService', 'AuthService', 'NotificationService',
  'CrudGenerator', 'DBWrapper', 'PGlite',
];

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates a random SQL keyword */
const sqlKeywordArb = fc.constantFrom(...SQL_KEYWORDS);

/** Generates a random table name */
const tableNameArb = fc.constantFrom(...TABLE_NAMES);

/** Generates a random internal service name */
const serviceNameArb = fc.constantFrom(...INTERNAL_SERVICES);

/** Generates a path segment (lowercase alpha + underscore, 2-8 chars) */
const pathSegmentArb = fc.tuple(
  fc.constantFrom('src', 'lib', 'utils', 'config', 'middleware', 'routes', 'services', 'handlers', 'controllers', 'models'),
).map(([seg]) => seg);

/** Generates a Unix-style file path */
const unixFilePathArb = fc.tuple(
  fc.constantFrom('/app', '/usr/local', '/home/user', '/var/lib'),
  fc.array(pathSegmentArb, { minLength: 1, maxLength: 3 }),
  fc.constantFrom('.ts', '.js', '.json', '.sql', '.mjs', '.cjs'),
).map(([base, segments, ext]) => `${base}/${segments.join('/')}${ext}`);

/** Generates a Windows-style file path */
const windowsFilePathArb = fc.tuple(
  fc.constantFrom('C:', 'D:', 'E:'),
  fc.array(pathSegmentArb, { minLength: 1, maxLength: 3 }),
  fc.constantFrom('.ts', '.js', '.json', '.sql'),
).map(([drive, segments, ext]) => `${drive}\\${segments.join('\\')}${ext}`);

/** Generates a file path (either Unix or Windows) */
const filePathArb = fc.oneof(unixFilePathArb, windowsFilePathArb);

/** Generates a stack trace line */
const stackTraceArb = fc.tuple(
  fc.constantFrom('Function.run', 'Object.handler', 'Module._compile', 'processTicksAndRejections', 'Router.handle'),
  unixFilePathArb,
  fc.integer({ min: 1, max: 500 }),
  fc.integer({ min: 1, max: 80 }),
).map(([fn, path, line, col]) => `    at ${fn} (${path}:${line}:${col})`);

/** Generates a surrounding text snippet that won't itself be matched by sanitization patterns */
const safeTextArb = fc.constantFrom(
  'Error occurred while processing request',
  'Failed to complete operation',
  'An issue happened during execution',
  'Could not finalize the action',
  'Something went wrong in the system',
  'Unable to proceed with the task',
  'Operation terminated unexpectedly',
  'The request could not be fulfilled',
);

// ─── Regex patterns for verifying sanitization ───────────────────────────────

/** Matches known SQL keywords as whole words (case-insensitive) */
const sqlRegex = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|CREATE|ALTER|DROP|INDEX|CONSTRAINT|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|REFERENCES|ON\s+DELETE|ON\s+UPDATE|CASCADE|SET\s+NULL|RETURNING|VALUES|INTO)\b/gi;

/** Matches file paths */
const filePathRegex = /(?:[A-Za-z]:)?(?:\/|\\)[\w.\-/\\]+(?:\.(?:ts|js|json|sql|mjs|cjs))?/g;

/** Matches stack trace patterns */
const stackTraceRegex = /\s+at\s+.+\(.+:\d+:\d+\)/g;

/** Matches internal service names */
const serviceRegex = /\b(?:BaseService|AuthService|NotificationService|CrudGenerator|DBWrapper|PGlite)\b/g;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 10: Error Message Sanitization', () => {
  it('removes SQL keywords from error messages', () => {
    fc.assert(
      fc.property(
        sqlKeywordArb,
        safeTextArb,
        (sqlKeyword, context) => {
          const message = `${context}: ${sqlKeyword} * from table`;
          const sanitized = sanitizeErrorMessage(message);

          // The sanitized output must not contain the SQL keyword as a whole word
          const matches = sanitized.match(sqlRegex);
          expect(matches).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('removes Unix file paths from error messages', () => {
    fc.assert(
      fc.property(
        unixFilePathArb,
        safeTextArb,
        (filePath, context) => {
          const message = `${context} in ${filePath}`;
          const sanitized = sanitizeErrorMessage(message);

          // The sanitized output must not contain file path patterns
          const matches = sanitized.match(filePathRegex);
          expect(matches).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('removes Windows file paths from error messages', () => {
    fc.assert(
      fc.property(
        windowsFilePathArb,
        safeTextArb,
        (filePath, context) => {
          const message = `${context} in ${filePath}`;
          const sanitized = sanitizeErrorMessage(message);

          // The sanitized output must not contain file path patterns
          const matches = sanitized.match(filePathRegex);
          expect(matches).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('removes stack traces from error messages', () => {
    fc.assert(
      fc.property(
        stackTraceArb,
        safeTextArb,
        (stackTrace, context) => {
          const message = `${context}\n${stackTrace}`;
          const sanitized = sanitizeErrorMessage(message);

          // The sanitized output must not contain stack trace patterns
          const matches = sanitized.match(stackTraceRegex);
          expect(matches).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('removes known table names from error messages', () => {
    fc.assert(
      fc.property(
        tableNameArb,
        safeTextArb,
        (tableName, context) => {
          const message = `${context}: relation "${tableName}" does not exist`;
          const sanitized = sanitizeErrorMessage(message);

          // The sanitized output must not contain the table name as a word
          const tableRegex = new RegExp(`\\b${tableName}\\b`, 'gi');
          expect(sanitized).not.toMatch(tableRegex);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('removes internal service names from error messages', () => {
    fc.assert(
      fc.property(
        serviceNameArb,
        safeTextArb,
        (serviceName, context) => {
          const message = `${context}: ${serviceName}.execute() failed`;
          const sanitized = sanitizeErrorMessage(message);

          // The sanitized output must not contain internal service names
          const matches = sanitized.match(serviceRegex);
          expect(matches).toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('removes all sensitive patterns from messages containing multiple pattern types', () => {
    fc.assert(
      fc.property(
        sqlKeywordArb,
        filePathArb,
        stackTraceArb,
        tableNameArb,
        serviceNameArb,
        (sqlKeyword, filePath, stackTrace, tableName, serviceName) => {
          // Construct a message containing ALL sensitive pattern types
          const message = [
            `Error in ${serviceName}: ${sqlKeyword} * FROM ${tableName}`,
            `File: ${filePath}`,
            stackTrace,
          ].join('\n');

          const sanitized = sanitizeErrorMessage(message);

          // Verify NO sensitive patterns remain
          expect(sanitized.match(sqlRegex)).toBeNull();
          expect(sanitized.match(filePathRegex)).toBeNull();
          expect(sanitized.match(stackTraceRegex)).toBeNull();
          expect(sanitized.match(serviceRegex)).toBeNull();

          // Verify table name is removed
          const tableRegex = new RegExp(`\\b${tableName}\\b`, 'gi');
          expect(sanitized).not.toMatch(tableRegex);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns a non-empty string for any non-empty input', () => {
    fc.assert(
      fc.property(
        safeTextArb,
        fc.constantFrom(...SQL_KEYWORDS),
        (context, sqlKeyword) => {
          const message = `${context}: ${sqlKeyword} operation failed`;
          const sanitized = sanitizeErrorMessage(message);

          // Sanitized output should always be a non-empty string
          expect(typeof sanitized).toBe('string');
          expect(sanitized.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns default message for empty or falsy input', () => {
    expect(sanitizeErrorMessage('')).toBe('An error occurred');
  });
});
