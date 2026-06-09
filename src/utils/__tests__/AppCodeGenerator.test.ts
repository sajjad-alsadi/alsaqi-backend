// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mock references that can be used in vi.mock factories
const { mockPrepare, mockValidateIdentifier } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
  mockValidateIdentifier: vi.fn((name: string) => {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error(`Invalid database identifier: ${name}`);
    }
    return name;
  }),
}));

// Mock the database module
vi.mock('../../db/index', () => ({
  db: {
    prepare: mockPrepare,
    validateIdentifier: mockValidateIdentifier,
  },
}));

import { AppCodeGenerator } from '../AppCodeGenerator';

describe('AppCodeGenerator', () => {
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet = vi.fn();
    mockPrepare.mockReturnValue({
      get: mockGet,
      all: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    });
  });

  const shortYear = new Date().getFullYear().toString().slice(-2);

  describe('generateCode', () => {
    it('should return code in format {DeptCode}-{DocType}-{YY}-{NNN} for supported tables', async () => {
      // No department found → defaults to 'IA'; no existing records → 001
      mockGet.mockResolvedValue(null);

      const result = await AppCodeGenerator.generateCode('audit_plans');

      expect(result).toBe(`IA-PL-${shortYear}-001`);
      expect(result).toMatch(/^[A-Z]{2,4}-[A-Z]{2,3}-\d{2}-\d{3}$/);
    });

    it('should return null for tables without code columns', async () => {
      const result = await AppCodeGenerator.generateCode('unknown_table');

      expect(result).toBeNull();
      // Should not even call db.prepare for unknown tables
    });

    it('should increment the number when existing codes exist', async () => {
      // When no departmentName is provided, resolveDepartmentCode skips db calls and returns 'IA'
      // So the only db.prepare().get() call is the LIKE query for the latest record
      mockPrepare.mockImplementation((sql: string) => ({
        get: vi.fn().mockImplementation(async (...params: any[]) => {
          if (sql.includes('LIKE')) {
            return { code: `IA-PL-${shortYear}-005` };
          }
          return null;
        }),
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
      }));

      const result = await AppCodeGenerator.generateCode('audit_plans');

      expect(result).toBe(`IA-PL-${shortYear}-006`);
    });

    it('should use "IA" as default department code when no department specified', async () => {
      mockGet.mockResolvedValue(null);

      const result = await AppCodeGenerator.generateCode('audit_plans');

      expect(result).toContain('IA-');
    });

    it('should use correct DocType for each supported table', async () => {
      const expectedDocTypes: Record<string, string> = {
        audit_plans: 'PL',
        audit_programs: 'PR',
        audit_tasks: 'TSK',
        audit_findings: 'FD',
        recommendations: 'REC',
        risk_register: 'RSK',
        compliance_items: 'CMP',
      };

      for (const [table, docType] of Object.entries(expectedDocTypes)) {
        vi.clearAllMocks();
        mockPrepare.mockReturnValue({
          get: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue([]),
          run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
        });

        const result = await AppCodeGenerator.generateCode(table);

        expect(result).toContain(`-${docType}-`);
      }
    });

    it('should use department entity_code when department name is provided and found', async () => {
      // org_entities query returns entity_code 'FIN'
      mockGet
        .mockResolvedValueOnce({ entity_code: 'FIN' }) // org_entities match
        .mockResolvedValueOnce(null); // no existing records (LIKE query)

      const result = await AppCodeGenerator.generateCode('audit_plans', 'Finance');

      expect(result).toBe(`FIN-PL-${shortYear}-001`);
    });
  });

  describe('generateFindingCode', () => {
    it('should return code in format {plan_code}-FD-{NNN} when audit plan has a plan_code', async () => {
      mockGet
        .mockResolvedValueOnce({ plan_code: `IA-PL-${shortYear}-003`, department: 'IT' }) // plan lookup
        .mockResolvedValueOnce(null); // no existing findings with this prefix

      const result = await AppCodeGenerator.generateFindingCode('audit-plan-id-123');

      expect(result).toBe(`IA-PL-${shortYear}-003-FD-001`);
    });

    it('should fall back to generic format when audit plan has no plan_code', async () => {
      // Plan exists but has no plan_code
      mockGet
        .mockResolvedValueOnce({ plan_code: null, department: 'IT' }) // plan lookup - no plan_code
        .mockResolvedValueOnce({ entity_code: 'IT' }) // resolveDepartmentCode → org_entities
        .mockResolvedValueOnce(null); // no existing records (LIKE query)

      const result = await AppCodeGenerator.generateFindingCode('audit-plan-id-456');

      // Falls back to generateCode('audit_findings', 'IT')
      expect(result).toMatch(new RegExp(`^IT-FD-${shortYear}-\\d{3}$`));
    });

    it('should increment finding number correctly', async () => {
      mockGet
        .mockResolvedValueOnce({ plan_code: `IA-PL-${shortYear}-001`, department: 'IA' }) // plan lookup
        .mockResolvedValueOnce({ code: `IA-PL-${shortYear}-001-FD-003` }); // existing finding

      const result = await AppCodeGenerator.generateFindingCode('audit-plan-id-789');

      expect(result).toBe(`IA-PL-${shortYear}-001-FD-004`);
    });

    it('should handle error and fall back to generateCode', async () => {
      // First call throws an error
      mockGet.mockRejectedValueOnce(new Error('DB error'));
      // Then resolveDepartmentCode calls
      mockGet.mockResolvedValueOnce(null); // org_entities
      mockGet.mockResolvedValueOnce(null); // LIKE query

      // Need to re-setup mockPrepare to handle the error case
      mockPrepare.mockReturnValue({
        get: mockGet,
        all: vi.fn().mockResolvedValue([]),
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
      });

      const result = await AppCodeGenerator.generateFindingCode('bad-id');

      // Should fall back to generic format
      expect(result).toMatch(new RegExp(`^IA-FD-${shortYear}-\\d{3}$`));
    });
  });

  describe('resolveDepartmentCode', () => {
    it('should return entity_code from org_entities when department name matches', async () => {
      mockGet.mockResolvedValueOnce({ entity_code: 'FIN' });

      const result = await AppCodeGenerator.resolveDepartmentCode('Finance');

      expect(result).toBe('FIN');
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('org_entities')
      );
    });

    it('should return "IA" as default when department not found', async () => {
      mockGet.mockResolvedValueOnce(null); // org_entities returns nothing
      mockGet.mockResolvedValueOnce(null); // departments fallback returns nothing

      const result = await AppCodeGenerator.resolveDepartmentCode('NonExistentDept');

      expect(result).toBe('IA');
    });

    it('should return "IA" when no department name provided', async () => {
      const result = await AppCodeGenerator.resolveDepartmentCode();

      expect(result).toBe('IA');
    });

    it('should return "IA" when no department name provided (undefined)', async () => {
      const result = await AppCodeGenerator.resolveDepartmentCode(undefined);

      expect(result).toBe('IA');
    });

    it('should return "IA" when db throws an error', async () => {
      mockGet.mockRejectedValueOnce(new Error('Connection failed'));

      const result = await AppCodeGenerator.resolveDepartmentCode('SomeDept');

      expect(result).toBe('IA');
    });
  });
});
