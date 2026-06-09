// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property Tests for AuditProgramService (Properties 7 & 8)
 *
 * Feature: audit-modules-restructure
 *
 * Property 7: Program creation restricted to auditors
 * Property 8: Program risks from registry
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: vi.fn(async (fn: Function) => fn()),
      validateIdentifier: vi.fn((id: string) => id),
    },
  };
});

vi.mock('../NotificationService', () => ({
  NotificationService: {
    create: vi.fn().mockResolvedValue(true),
    getAdminIds: vi.fn().mockResolvedValue([]),
  },
}));

import { AuditProgramService } from '../AuditProgramService';
import { db } from '../../db/index';
import { ForbiddenError, ValidationError } from '../../utils/errors';
import { UserRole } from '@alsaqi/shared';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** All roles that are NOT Internal Auditor */
const nonAuditorRoleArb = fc.constantFrom(
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.COMPLIANCE_OFFICER,
  UserRole.RISK_OFFICER,
  UserRole.VIEWER
);

/** Generate a valid UUID-like string */
const uuidArb = fc.uuid();

/** Generate a non-empty set of unique risk IDs (1 to 10 for performance) */
const riskIdsArb = fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 10 });

/** Generate valid program creation data */
const validProgramDataArb = fc.record({
  program_code: fc.string({ minLength: 1, maxLength: 20 }),
  program_title: fc.string({ minLength: 1, maxLength: 100 }),
  audit_area: fc.string({ minLength: 1, maxLength: 50 }),
  department: fc.string({ minLength: 1, maxLength: 50 }),
  audit_type: fc.constantFrom('Operational', 'Financial', 'Compliance', 'IT', 'AML', 'Governance'),
  audit_objective: fc.string({ minLength: 1, maxLength: 200 }),
  audit_scope: fc.string({ minLength: 1, maxLength: 200 }),
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Property 7: Program creation restricted to auditors', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 5.1, 5.2**
   *
   * For any role that is NOT 'Internal Auditor', calling createProgram must throw
   * ForbiddenError. Only Internal Auditor can create programs.
   *
   * This property ensures the system enforces role-based access control on program creation.
   */
  it('createProgram throws ForbiddenError for any non-Internal Auditor role', async () => {
    await fc.assert(
      fc.asyncProperty(
        validProgramDataArb,
        uuidArb,
        nonAuditorRoleArb,
        async (programData, userId, role) => {
          vi.clearAllMocks();

          const data = {
            ...programData,
            risk_ids: [],
            compliance_item_ids: [],
          };

          await expect(
            AuditProgramService.createProgram(data, userId, role)
          ).rejects.toThrow(ForbiddenError);

          // Verify no database operations were attempted (no program created)
          expect(mockDb.prepare).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.1**
   *
   * For the Internal Auditor role with valid data, createProgram must NOT throw
   * ForbiddenError. It should proceed with program creation.
   *
   * This property ensures Internal Auditor is always allowed to create programs.
   */
  it('createProgram does NOT throw ForbiddenError for Internal Auditor role', async () => {
    await fc.assert(
      fc.asyncProperty(
        validProgramDataArb,
        uuidArb,
        async (programData, userId) => {
          vi.clearAllMocks();

          const data = {
            ...programData,
            risk_ids: [],
            compliance_item_ids: [],
          };

          // Mock: INSERT program succeeds
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: 'new-program-id' }),
          });
          // Mock: SELECT Manager/Admin users for notification
          mockDb.prepare.mockReturnValueOnce({
            all: vi.fn().mockResolvedValue([]),
          });

          // Should NOT throw ForbiddenError
          const result = await AuditProgramService.createProgram(
            data,
            userId,
            UserRole.INTERNAL_AUDITOR
          );

          expect(result).toHaveProperty('programId');
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('Property 8: Program risks from registry', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 5.3, 5.4**
   *
   * For any set of risk_ids, if any ID does not exist in risk_register,
   * createProgram must throw ValidationError. All provided risk_ids must
   * exist in the registry.
   *
   * This property ensures that programs can only reference risks that exist
   * in the risk register, preventing dangling references.
   */
  it('createProgram throws ValidationError when any risk_id does not exist in risk_register', async () => {
    await fc.assert(
      fc.asyncProperty(
        validProgramDataArb,
        uuidArb,
        riskIdsArb,
        fc.integer({ min: 0, max: 9 }),
        async (programData, userId, riskIds, missingIndex) => {
          vi.clearAllMocks();

          // Ensure missingIndex is within bounds
          const actualMissingIndex = missingIndex % riskIds.length;

          // Simulate: one risk ID is missing from the registry
          const existingRisks = riskIds
            .filter((_, idx) => idx !== actualMissingIndex)
            .map(id => ({ id }));

          const data = {
            ...programData,
            risk_ids: riskIds,
            compliance_item_ids: [],
          };

          // Mock: risk_register query returns all except the missing one
          mockDb.prepare.mockReturnValueOnce({
            all: vi.fn().mockResolvedValue(existingRisks),
          });

          await expect(
            AuditProgramService.createProgram(data, userId, UserRole.INTERNAL_AUDITOR)
          ).rejects.toThrow(ValidationError);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.3**
   *
   * For any set of risk_ids where ALL IDs exist in risk_register,
   * createProgram must NOT throw ValidationError for risk validation.
   * The program should be created successfully with risk links.
   *
   * This property ensures that valid risk references are accepted.
   */
  it('createProgram succeeds when all risk_ids exist in risk_register', async () => {
    await fc.assert(
      fc.asyncProperty(
        validProgramDataArb,
        uuidArb,
        riskIdsArb,
        async (programData, userId, riskIds) => {
          vi.clearAllMocks();

          const data = {
            ...programData,
            risk_ids: riskIds,
            compliance_item_ids: [],
          };

          // Mock: all risk_ids exist in risk_register
          mockDb.prepare.mockReturnValueOnce({
            all: vi.fn().mockResolvedValue(riskIds.map(id => ({ id }))),
          });
          // Mock: INSERT program
          mockDb.prepare.mockReturnValueOnce({
            get: vi.fn().mockResolvedValue({ id: 'new-program-id' }),
          });
          // Mock: INSERT risk links (one per risk_id)
          for (let i = 0; i < riskIds.length; i++) {
            mockDb.prepare.mockReturnValueOnce({
              run: vi.fn().mockResolvedValue({ changes: 1 }),
            });
          }
          // Mock: SELECT Manager/Admin users for notification
          mockDb.prepare.mockReturnValueOnce({
            all: vi.fn().mockResolvedValue([]),
          });

          const result = await AuditProgramService.createProgram(
            data,
            userId,
            UserRole.INTERNAL_AUDITOR
          );

          expect(result).toHaveProperty('programId');
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * **Validates: Requirements 5.4**
   *
   * For any set of risk_ids containing duplicates, createProgram must throw
   * ValidationError. Duplicate risk references are not allowed.
   */
  it('createProgram throws ValidationError when risk_ids contain duplicates', async () => {
    await fc.assert(
      fc.asyncProperty(
        validProgramDataArb,
        uuidArb,
        fc.uuid(),
        async (programData, userId, duplicateId) => {
          vi.clearAllMocks();

          // Create a list with at least one duplicate
          const riskIds = [duplicateId, 'other-risk-id', duplicateId];

          const data = {
            ...programData,
            risk_ids: riskIds,
            compliance_item_ids: [],
          };

          await expect(
            AuditProgramService.createProgram(data, userId, UserRole.INTERNAL_AUDITOR)
          ).rejects.toThrow(ValidationError);
        }
      ),
      { numRuns: 200 }
    );
  });
});
