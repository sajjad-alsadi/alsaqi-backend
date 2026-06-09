import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Preservation Property Tests - Fallback Code Generation and Other Entity Behavior Unchanged
 *
 * **Validates: Requirements 3.1, 3.2**
 *
 * These tests confirm that the CURRENT (unfixed) behavior for non-finding entity types
 * and for findings created under plans with NO plan_code is preserved.
 *
 * EXPECTED OUTCOME: Tests PASS on unfixed code (confirms baseline behavior to preserve)
 */

// Mock the database module
vi.mock('../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      validateIdentifier: (id: string) => {
        if (!/^[a-zA-Z0-9_]+$/.test(id)) {
          throw new Error(`Invalid database identifier: ${id}`);
        }
        return id;
      },
    },
  };
});

import { AppCodeGenerator } from './AppCodeGenerator';
import { db } from '../db/index';

describe('Preservation: Fallback Code Generation and Other Entity Behavior Unchanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper to set up db mock for generateCode calls.
   * - resolveDepartmentCode returns the provided deptCode
   * - The LIKE query for latest record returns null (no existing records)
   */
  function setupDbMock(deptCode = 'IA') {
    const mockGet = vi.fn();
    (db.prepare as any).mockImplementation((sql: string) => {
      return {
        get: async (...params: any[]) => {
          // For resolveDepartmentCode query
          if (sql.includes('org_entities')) {
            return { entity_code: deptCode };
          }
          // For the LIKE query to find latest record
          if (sql.includes('LIKE')) {
            return null; // No existing records, so next number is 001
          }
          return null;
        },
        all: async (...params: any[]) => [],
        run: async (...params: any[]) => ({ lastInsertRowid: 1, changes: 1 }),
      };
    });
  }

  /**
   * **Validates: Requirements 3.2**
   *
   * Property: For all non-finding entity types, generateCode(entityType, dept) output
   * matches original format {DeptCode}-{DocType}-{YY}-{NNN}
   */
  describe('Non-finding entity code generation format is preserved', () => {
    const entityDocTypes: Record<string, string> = {
      audit_plans: 'PL',
      audit_programs: 'PR',
      audit_tasks: 'TSK',
      recommendations: 'REC',
      risk_register: 'RSK',
      compliance_items: 'CMP',
    };

    it('Property: audit_plans generateCode returns {DeptCode}-PL-{YY}-{NNN} format', async () => {
      /**
       * **Validates: Requirements 3.2**
       */
      setupDbMock('IA');
      const result = await AppCodeGenerator.generateCode('audit_plans', 'IA');
      const shortYear = new Date().getFullYear().toString().slice(-2);
      expect(result).toMatch(new RegExp(`^IA-PL-${shortYear}-\\d{3}$`));
      expect(result).toBe(`IA-PL-${shortYear}-001`);
    });

    it('Property: audit_programs generateCode returns {DeptCode}-PR-{YY}-{NNN} format', async () => {
      /**
       * **Validates: Requirements 3.2**
       */
      setupDbMock('IA');
      const result = await AppCodeGenerator.generateCode('audit_programs', 'IA');
      const shortYear = new Date().getFullYear().toString().slice(-2);
      expect(result).toMatch(new RegExp(`^IA-PR-${shortYear}-\\d{3}$`));
      expect(result).toBe(`IA-PR-${shortYear}-001`);
    });

    it('Property: audit_tasks generateCode returns {DeptCode}-TSK-{YY}-{NNN} format', async () => {
      /**
       * **Validates: Requirements 3.2**
       */
      setupDbMock('IA');
      const result = await AppCodeGenerator.generateCode('audit_tasks', 'IA');
      const shortYear = new Date().getFullYear().toString().slice(-2);
      expect(result).toMatch(new RegExp(`^IA-TSK-${shortYear}-\\d{3}$`));
      expect(result).toBe(`IA-TSK-${shortYear}-001`);
    });

    it('Property: recommendations generateCode returns {DeptCode}-REC-{YY}-{NNN} format', async () => {
      /**
       * **Validates: Requirements 3.2**
       */
      setupDbMock('IA');
      const result = await AppCodeGenerator.generateCode('recommendations', 'IA');
      const shortYear = new Date().getFullYear().toString().slice(-2);
      expect(result).toMatch(new RegExp(`^IA-REC-${shortYear}-\\d{3}$`));
      expect(result).toBe(`IA-REC-${shortYear}-001`);
    });

    it('Property: risk_register generateCode returns {DeptCode}-RSK-{YY}-{NNN} format', async () => {
      /**
       * **Validates: Requirements 3.2**
       */
      setupDbMock('IA');
      const result = await AppCodeGenerator.generateCode('risk_register', 'IA');
      const shortYear = new Date().getFullYear().toString().slice(-2);
      expect(result).toMatch(new RegExp(`^IA-RSK-${shortYear}-\\d{3}$`));
      expect(result).toBe(`IA-RSK-${shortYear}-001`);
    });

    it('Property: compliance_items generateCode returns {DeptCode}-CMP-{YY}-{NNN} format', async () => {
      /**
       * **Validates: Requirements 3.2**
       */
      setupDbMock('IA');
      const result = await AppCodeGenerator.generateCode('compliance_items', 'IA');
      const shortYear = new Date().getFullYear().toString().slice(-2);
      expect(result).toMatch(new RegExp(`^IA-CMP-${shortYear}-\\d{3}$`));
      expect(result).toBe(`IA-CMP-${shortYear}-001`);
    });

    it('Property-based: for all non-finding entity types with arbitrary dept codes, format is {DeptCode}-{DocType}-{YY}-{NNN}', async () => {
      /**
       * **Validates: Requirements 3.2**
       */
      const shortYear = new Date().getFullYear().toString().slice(-2);
      const entityTypes = Object.keys(entityDocTypes);

      // Use fast-check to generate random department codes and entity types
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...entityTypes),
          fc.stringMatching(/^[A-Z]{2,4}$/),
          async (entityType, deptCode) => {
            setupDbMock(deptCode);
            const result = await AppCodeGenerator.generateCode(entityType, deptCode);
            const expectedDocType = entityDocTypes[entityType];
            const pattern = new RegExp(`^${deptCode}-${expectedDocType}-${shortYear}-\\d{3}$`);
            expect(result).toMatch(pattern);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  /**
   * **Validates: Requirements 3.1**
   *
   * Property: For findings created under plans with NO plan_code, generated code
   * matches fallback format {DeptCode}-FD-{YY}-{NNN}
   */
  describe('Findings fallback code generation (no plan_code) is preserved', () => {
    it('Property: audit_findings generateCode returns {DeptCode}-FD-{YY}-{NNN} format', async () => {
      /**
       * **Validates: Requirements 3.1**
       */
      setupDbMock('IA');
      const result = await AppCodeGenerator.generateCode('audit_findings', 'IA');
      const shortYear = new Date().getFullYear().toString().slice(-2);
      expect(result).toMatch(new RegExp(`^IA-FD-${shortYear}-\\d{3}$`));
      expect(result).toBe(`IA-FD-${shortYear}-001`);
    });

    it('Property-based: for findings with arbitrary dept codes, fallback format is {DeptCode}-FD-{YY}-{NNN}', async () => {
      /**
       * **Validates: Requirements 3.1**
       */
      const shortYear = new Date().getFullYear().toString().slice(-2);

      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^[A-Z]{2,4}$/),
          async (deptCode) => {
            setupDbMock(deptCode);
            const result = await AppCodeGenerator.generateCode('audit_findings', deptCode);
            const pattern = new RegExp(`^${deptCode}-FD-${shortYear}-\\d{3}$`);
            expect(result).toMatch(pattern);
          }
        ),
        { numRuns: 20 }
      );
    });

    it('Property: sequential numbering increments correctly when existing records exist', async () => {
      /**
       * **Validates: Requirements 3.1**
       */
      const shortYear = new Date().getFullYear().toString().slice(-2);

      // Mock db to return an existing record with code ending in 005
      (db.prepare as any).mockImplementation((sql: string) => {
        return {
          get: async (...params: any[]) => {
            if (sql.includes('org_entities')) {
              return { entity_code: 'IA' };
            }
            if (sql.includes('LIKE')) {
              return { code: `IA-FD-${shortYear}-005` };
            }
            return null;
          },
          all: async (...params: any[]) => [],
          run: async (...params: any[]) => ({ lastInsertRowid: 1, changes: 1 }),
        };
      });

      const result = await AppCodeGenerator.generateCode('audit_findings', 'IA');
      expect(result).toBe(`IA-FD-${shortYear}-006`);
    });
  });

  /**
   * **Validates: Requirements 3.2**
   *
   * Property: generateCode returns null for unknown table names
   */
  describe('Unknown table names return null', () => {
    it('Property: generateCode returns null for tables not in TABLE_CODE_COLUMNS', async () => {
      /**
       * **Validates: Requirements 3.2**
       */
      setupDbMock('IA');
      const result = await AppCodeGenerator.generateCode('unknown_table', 'IA');
      expect(result).toBeNull();
    });
  });
});
