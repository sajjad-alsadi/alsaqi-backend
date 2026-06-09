// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
    },
  };
});

import { NumberingService, NumberingOverflowError } from '../NumberingService';
import { db } from '../../db/index';

describe('NumberingService', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupCounterResponse(lastValue: number) {
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockResolvedValue({ last_value: lastValue }),
    });
  }

  describe('nextCounter', () => {
    it('should return the last_value from UPSERT result', async () => {
      setupCounterResponse(1);

      const result = await NumberingService.nextCounter('plan_year', '2025');

      expect(result).toBe(1);
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO numbering_counters')
      );
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT (scope_type, scope_id)')
      );
    });

    it('should throw if no row is returned', async () => {
      mockDb.prepare.mockReturnValue({
        get: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        NumberingService.nextCounter('plan_year', '2025')
      ).rejects.toThrow('Failed to generate counter');
    });

    it('should pass correct parameters to the query', async () => {
      const mockGet = vi.fn().mockResolvedValue({ last_value: 5 });
      mockDb.prepare.mockReturnValue({ get: mockGet });

      await NumberingService.nextCounter('task', 'plan-uuid-123');

      expect(mockGet).toHaveBeenCalledWith('task', 'plan-uuid-123');
    });
  });

  describe('nextPlanCode', () => {
    it('should generate IA-PL-{YY}-{NNN} format for first plan', async () => {
      setupCounterResponse(1);

      const code = await NumberingService.nextPlanCode(2025);

      expect(code).toBe('IA-PL-25-001');
    });

    it('should pad sequence to 3 digits', async () => {
      setupCounterResponse(42);

      const code = await NumberingService.nextPlanCode(2025);

      expect(code).toBe('IA-PL-25-042');
    });

    it('should handle year 2000 (YY = 00)', async () => {
      setupCounterResponse(1);

      const code = await NumberingService.nextPlanCode(2000);

      expect(code).toBe('IA-PL-00-001');
    });

    it('should handle year 2099 (YY = 99)', async () => {
      setupCounterResponse(999);

      const code = await NumberingService.nextPlanCode(2099);

      expect(code).toBe('IA-PL-99-999');
    });

    it('should throw NumberingOverflowError when sequence exceeds 999', async () => {
      setupCounterResponse(1000);

      await expect(
        NumberingService.nextPlanCode(2025)
      ).rejects.toThrow(NumberingOverflowError);
    });

    it('should include scope info in overflow error message', async () => {
      setupCounterResponse(1000);

      await expect(
        NumberingService.nextPlanCode(2025)
      ).rejects.toThrow(/plan_year.*2025.*999/);
    });
  });

  describe('nextTaskNumber', () => {
    it('should generate {planCode}-T{NN} format', async () => {
      setupCounterResponse(1);

      const num = await NumberingService.nextTaskNumber('plan-id', 'IA-PL-25-001');

      expect(num).toBe('IA-PL-25-001-T01');
    });

    it('should pad sequence to 2 digits', async () => {
      setupCounterResponse(7);

      const num = await NumberingService.nextTaskNumber('plan-id', 'IA-PL-25-001');

      expect(num).toBe('IA-PL-25-001-T07');
    });

    it('should use planId as scope_id for counter', async () => {
      const mockGet = vi.fn().mockResolvedValue({ last_value: 1 });
      mockDb.prepare.mockReturnValue({ get: mockGet });

      await NumberingService.nextTaskNumber('my-plan-uuid', 'IA-PL-25-001');

      expect(mockGet).toHaveBeenCalledWith('task', 'my-plan-uuid');
    });

    it('should throw NumberingOverflowError when sequence exceeds 99', async () => {
      setupCounterResponse(100);

      await expect(
        NumberingService.nextTaskNumber('plan-id', 'IA-PL-25-001')
      ).rejects.toThrow(NumberingOverflowError);
    });
  });

  describe('nextFindingNumber', () => {
    it('should generate {planCode}-F{NN} format', async () => {
      setupCounterResponse(1);

      const num = await NumberingService.nextFindingNumber('plan-id', 'IA-PL-25-001');

      expect(num).toBe('IA-PL-25-001-F01');
    });

    it('should pad sequence to 2 digits', async () => {
      setupCounterResponse(15);

      const num = await NumberingService.nextFindingNumber('plan-id', 'IA-PL-25-001');

      expect(num).toBe('IA-PL-25-001-F15');
    });

    it('should use planId as scope_id for counter', async () => {
      const mockGet = vi.fn().mockResolvedValue({ last_value: 1 });
      mockDb.prepare.mockReturnValue({ get: mockGet });

      await NumberingService.nextFindingNumber('my-plan-uuid', 'IA-PL-25-001');

      expect(mockGet).toHaveBeenCalledWith('finding', 'my-plan-uuid');
    });

    it('should throw NumberingOverflowError when sequence exceeds 99', async () => {
      setupCounterResponse(100);

      await expect(
        NumberingService.nextFindingNumber('plan-id', 'IA-PL-25-001')
      ).rejects.toThrow(NumberingOverflowError);
    });
  });

  describe('nextRecommendationNumber', () => {
    it('should generate {findingNumber}-R{NN} format', async () => {
      setupCounterResponse(1);

      const num = await NumberingService.nextRecommendationNumber(
        'finding-id',
        'IA-PL-25-001-F01'
      );

      expect(num).toBe('IA-PL-25-001-F01-R01');
    });

    it('should pad sequence to 2 digits', async () => {
      setupCounterResponse(3);

      const num = await NumberingService.nextRecommendationNumber(
        'finding-id',
        'IA-PL-25-001-F02'
      );

      expect(num).toBe('IA-PL-25-001-F02-R03');
    });

    it('should use findingId as scope_id for counter', async () => {
      const mockGet = vi.fn().mockResolvedValue({ last_value: 1 });
      mockDb.prepare.mockReturnValue({ get: mockGet });

      await NumberingService.nextRecommendationNumber('my-finding-uuid', 'IA-PL-25-001-F01');

      expect(mockGet).toHaveBeenCalledWith('rec', 'my-finding-uuid');
    });

    it('should throw NumberingOverflowError when sequence exceeds 99', async () => {
      setupCounterResponse(100);

      await expect(
        NumberingService.nextRecommendationNumber('finding-id', 'IA-PL-25-001-F01')
      ).rejects.toThrow(NumberingOverflowError);
    });
  });

  describe('nextEvidenceNumber', () => {
    it('should generate {findingNumber}-E{NN} format', async () => {
      setupCounterResponse(1);

      const num = await NumberingService.nextEvidenceNumber(
        'finding-id',
        'IA-PL-25-001-F01'
      );

      expect(num).toBe('IA-PL-25-001-F01-E01');
    });

    it('should pad sequence to 2 digits', async () => {
      setupCounterResponse(12);

      const num = await NumberingService.nextEvidenceNumber(
        'finding-id',
        'IA-PL-25-001-F03'
      );

      expect(num).toBe('IA-PL-25-001-F03-E12');
    });

    it('should use findingId as scope_id for counter', async () => {
      const mockGet = vi.fn().mockResolvedValue({ last_value: 1 });
      mockDb.prepare.mockReturnValue({ get: mockGet });

      await NumberingService.nextEvidenceNumber('my-finding-uuid', 'IA-PL-25-001-F01');

      expect(mockGet).toHaveBeenCalledWith('evidence', 'my-finding-uuid');
    });

    it('should throw NumberingOverflowError when sequence exceeds 99', async () => {
      setupCounterResponse(100);

      await expect(
        NumberingService.nextEvidenceNumber('finding-id', 'IA-PL-25-001-F01')
      ).rejects.toThrow(NumberingOverflowError);
    });
  });

  describe('hierarchical numbering derivation', () => {
    it('should produce full hierarchy: plan → task', async () => {
      setupCounterResponse(3);
      const planCode = await NumberingService.nextPlanCode(2025);

      setupCounterResponse(5);
      const taskNum = await NumberingService.nextTaskNumber('plan-id', planCode);

      expect(taskNum).toBe('IA-PL-25-003-T05');
      expect(taskNum.startsWith(planCode)).toBe(true);
    });

    it('should produce full hierarchy: plan → finding → recommendation', async () => {
      setupCounterResponse(1);
      const planCode = await NumberingService.nextPlanCode(2025);

      setupCounterResponse(2);
      const findingNum = await NumberingService.nextFindingNumber('plan-id', planCode);

      setupCounterResponse(1);
      const recNum = await NumberingService.nextRecommendationNumber('finding-id', findingNum);

      expect(recNum).toBe('IA-PL-25-001-F02-R01');
      expect(recNum.startsWith(findingNum)).toBe(true);
      expect(findingNum.startsWith(planCode)).toBe(true);
    });

    it('should produce full hierarchy: plan → finding → evidence', async () => {
      setupCounterResponse(1);
      const planCode = await NumberingService.nextPlanCode(2025);

      setupCounterResponse(1);
      const findingNum = await NumberingService.nextFindingNumber('plan-id', planCode);

      setupCounterResponse(3);
      const evidenceNum = await NumberingService.nextEvidenceNumber('finding-id', findingNum);

      expect(evidenceNum).toBe('IA-PL-25-001-F01-E03');
      expect(evidenceNum.startsWith(findingNum)).toBe(true);
      expect(findingNum.startsWith(planCode)).toBe(true);
    });
  });
});
