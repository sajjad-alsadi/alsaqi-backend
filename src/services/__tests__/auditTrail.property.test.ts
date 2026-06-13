// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import crypto from 'crypto';

/**
 * Property 20: Audit Trail Record Completeness
 *
 * **Validates: Requirements 18.2, 19.2, 20.4**
 *
 * For any audit trail entry created by the system, the record SHALL contain
 * non-null values for `user`, `action`, `module`, and `details` fields plus
 * a system-generated timestamp.
 *
 * Strategy:
 * - Generate arbitrary non-empty strings for user, action, module, details
 * - Invoke the logAudit function via BaseService
 * - Capture the values passed to the database INSERT statement
 * - Verify all fields are non-null and the timestamp is a valid ISO date string
 */

// Track what gets inserted into the audit_trail table
let capturedInserts: Array<{
  user: string;
  action: string;
  module: string;
  details: string;
  hash: string;
  previousHash: string;
  timestamp: string;
}> = [];

// Mock the database module
vi.mock('../../db/index', () => {
  const prepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('SELECT hash FROM audit_trail')) {
      return {
        get: vi.fn().mockResolvedValue(null),
      };
    }
    if (sql.includes('INSERT INTO audit_trail')) {
      return {
        run: vi.fn().mockImplementation((...args: any[]) => {
          capturedInserts.push({
            user: args[0],
            action: args[1],
            module: args[2],
            details: args[3],
            hash: args[4],
            previousHash: args[5],
            timestamp: args[6],
          });
          return Promise.resolve({ lastInsertRowid: 1 });
        }),
      };
    }
    return {
      get: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({}),
    };
  });

  return {
    db: {
      // logAudit now delegates to AuditChainService.append, which wraps the
      // read-prev-hash -> compute -> insert in a single transaction. The mock
      // transaction simply executes the critical section inline.
      isExternal: false,
      transaction: vi.fn().mockImplementation(async (fn: Function) => fn()),
      exec: vi.fn().mockResolvedValue(undefined),
      prepare,
    },
  };
});

// Import BaseService after mocks are set up
import { BaseService } from '../BaseService';

describe('Property 20: Audit Trail Record Completeness', () => {
  beforeEach(() => {
    capturedInserts = [];
    vi.clearAllMocks();
  });

  // Arbitraries: generate non-empty strings for audit fields
  const usernameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9._]{2,30}$/);
  const actionArb = fc.constantFrom(
    'Login',
    'Logout',
    'Created',
    'Updated',
    'Deleted',
    'Approved',
    'Rejected',
    'Exported',
    'Imported',
    'Password Changed',
    'Permission Updated',
    'Created Conflict of Interest Declaration',
    'Updated Conflict of Interest Status',
    'Created Org Entity',
    'Updated Org Entity',
    'Archived Org Entity',
    'Created Job Title',
    'Updated Job Title',
    'Deleted Job Title'
  );
  const moduleArb = fc.constantFrom(
    'Auth',
    'Users',
    'Departments',
    'AuditPlans',
    'Findings',
    'Recommendations',
    'RiskRegister',
    'Correspondence',
    'Tasks',
    'Settings',
    'Governance',
    'OrgStructure',
    'Job Titles',
    'Reports'
  );
  const detailsArb = fc.string({ minLength: 1, maxLength: 200 });

  it('all audit trail records have non-null user, action, module, and details fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        actionArb,
        moduleArb,
        detailsArb,
        async (user, action, module, details) => {
          capturedInserts = [];

          await BaseService.logAudit(user, action, module, details);

          // Verify at least one insert was captured
          expect(capturedInserts.length).toBe(1);

          const record = capturedInserts[0];

          // All required fields MUST be non-null
          expect(record.user).not.toBeNull();
          expect(record.user).not.toBeUndefined();
          expect(record.user).toBe(user);
          expect(record.user.length).toBeGreaterThan(0);

          expect(record.action).not.toBeNull();
          expect(record.action).not.toBeUndefined();
          expect(record.action).toBe(action);
          expect(record.action.length).toBeGreaterThan(0);

          expect(record.module).not.toBeNull();
          expect(record.module).not.toBeUndefined();
          expect(record.module).toBe(module);
          expect(record.module.length).toBeGreaterThan(0);

          expect(record.details).not.toBeNull();
          expect(record.details).not.toBeUndefined();
          expect(record.details).toBe(details);
          expect(record.details.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all audit trail records have a system-generated timestamp', async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        actionArb,
        moduleArb,
        detailsArb,
        async (user, action, module, details) => {
          capturedInserts = [];

          const beforeTime = new Date();
          await BaseService.logAudit(user, action, module, details);
          const afterTime = new Date();

          expect(capturedInserts.length).toBe(1);

          const record = capturedInserts[0];

          // Timestamp must be non-null and non-empty
          expect(record.timestamp).not.toBeNull();
          expect(record.timestamp).not.toBeUndefined();
          expect(record.timestamp.length).toBeGreaterThan(0);

          // Timestamp must be a valid ISO 8601 string
          const parsedTimestamp = new Date(record.timestamp);
          expect(parsedTimestamp.toString()).not.toBe('Invalid Date');

          // Timestamp must be within the time window of the test execution
          expect(parsedTimestamp.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime() - 1000);
          expect(parsedTimestamp.getTime()).toBeLessThanOrEqual(afterTime.getTime() + 1000);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('audit trail records include hash chaining fields for tamper evidence', async () => {
    await fc.assert(
      fc.asyncProperty(
        usernameArb,
        actionArb,
        moduleArb,
        detailsArb,
        async (user, action, module, details) => {
          capturedInserts = [];

          await BaseService.logAudit(user, action, module, details);

          expect(capturedInserts.length).toBe(1);

          const record = capturedInserts[0];

          // Hash must be non-null and a valid SHA-256 hex string (64 chars)
          expect(record.hash).not.toBeNull();
          expect(record.hash).not.toBeUndefined();
          expect(record.hash).toMatch(/^[a-f0-9]{64}$/);

          // previousHash must be non-null (at minimum '0' for the first record)
          expect(record.previousHash).not.toBeNull();
          expect(record.previousHash).not.toBeUndefined();
          expect(record.previousHash.length).toBeGreaterThan(0);

          // Verify the hash is computed correctly from the record data
          const expectedRecordData = `${record.previousHash}|${user}|${action}|${module}|${details}|${record.timestamp}`;
          const expectedHash = crypto.createHash('sha256').update(expectedRecordData).digest('hex');
          expect(record.hash).toBe(expectedHash);
        }
      ),
      { numRuns: 100 }
    );
  });
});
