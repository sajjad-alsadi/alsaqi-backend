// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module
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

// Mock NumberingService
vi.mock('../NumberingService', () => ({
  NumberingService: {
    nextPlanCode: vi.fn(),
  },
}));

// Mock NotificationService
vi.mock('../NotificationService', () => ({
  NotificationService: {
    create: vi.fn(),
  },
}));

// Mock N8nService
vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock AppCodeGenerator
vi.mock('../../utils/AppCodeGenerator', () => ({
  AppCodeGenerator: {
    generateCode: vi.fn().mockResolvedValue(null),
    generateFindingCode: vi.fn().mockResolvedValue(null),
  },
}));

import { AuditPlanService } from '../AuditPlanService';
import { NumberingService } from '../NumberingService';
import { db } from '../../db/index';
import { ValidationError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors';

describe('AuditPlanService', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fiscalYearBounds', () => {
    it('should return Jan 1 - Dec 31 for a given year', () => {
      const bounds = AuditPlanService.fiscalYearBounds(2025);

      expect(bounds).toEqual({
        start: '2025-01-01',
        end: '2025-12-31',
      });
    });

    it('should handle year 2000', () => {
      const bounds = AuditPlanService.fiscalYearBounds(2000);

      expect(bounds).toEqual({
        start: '2000-01-01',
        end: '2000-12-31',
      });
    });

    it('should handle year 2100', () => {
      const bounds = AuditPlanService.fiscalYearBounds(2100);

      expect(bounds).toEqual({
        start: '2100-01-01',
        end: '2100-12-31',
      });
    });
  });

  describe('canCreateNewPlan', () => {
    it('should return allowed: true when no plan exists for the year and no unarchived previous year', async () => {
      // First call: check same year plans
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // Second call: check previous year unarchived plans
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      const result = await AuditPlanService.canCreateNewPlan(2025);

      expect(result).toEqual({ allowed: true });
    });

    it('should return allowed: false when a plan already exists for the same year', async () => {
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'existing-plan-id' }]),
      });

      const result = await AuditPlanService.canCreateNewPlan(2025);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('2025');
    });

    it('should return allowed: false when previous year plan is not archived', async () => {
      // No plan for same year
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // Previous year has unarchived plan
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'prev-plan', title: 'Plan 2024' }]),
      });

      const result = await AuditPlanService.canCreateNewPlan(2025);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('2024');
    });

    it('should allow creation when previous year plan is archived (not returned by query)', async () => {
      // No plan for same year
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // Previous year: no unarchived plans (archived ones are filtered by is_archived = false)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      const result = await AuditPlanService.canCreateNewPlan(2025);

      expect(result).toEqual({ allowed: true });
    });
  });

  describe('create', () => {
    function setupCreateMocks() {
      // canCreateNewPlan: same year check
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // canCreateNewPlan: previous year check
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // BaseService.create internal: INSERT
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ lastInsertRowid: 'new-plan-id', changes: 1 }),
      });

      (NumberingService.nextPlanCode as any).mockResolvedValue('IA-PL-25-001');
    }

    it('should throw ValidationError for year below 2000', async () => {
      await expect(
        AuditPlanService.create('audit_plans', { year: 1999, title: 'Test' })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for year above 2100', async () => {
      await expect(
        AuditPlanService.create('audit_plans', { year: 2101, title: 'Test' })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for non-integer year', async () => {
      await expect(
        AuditPlanService.create('audit_plans', { year: 2025.5, title: 'Test' })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for null/undefined year', async () => {
      await expect(
        AuditPlanService.create('audit_plans', { title: 'Test' })
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid quarter', async () => {
      await expect(
        AuditPlanService.create('audit_plans', { year: 2025, quarter: 'Q5', title: 'Test' })
      ).rejects.toThrow(ValidationError);
    });

    it('should accept valid quarter values: Q1, Q2, Q3, Q4, Annual', async () => {
      const validQuarters = ['Q1', 'Q2', 'Q3', 'Q4', 'Annual'];

      for (const quarter of validQuarters) {
        vi.clearAllMocks();
        setupCreateMocks();

        // Should not throw for valid quarters
        const result = await AuditPlanService.create('audit_plans', {
          year: 2025,
          quarter,
          title: `Test ${quarter}`,
          department: 'IT',
        });

        expect(result).toBeDefined();
      }
    });

    it('should default quarter to Annual when not provided', async () => {
      setupCreateMocks();

      const result = await AuditPlanService.create('audit_plans', {
        year: 2025,
        title: 'Test Plan',
        department: 'IT',
      });

      // The body passed to super.create should have quarter = 'Annual'
      expect(result.quarter).toBe('Annual');
    });

    it('should throw ConflictError when plan already exists for the year', async () => {
      // Same year check returns existing plan
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'existing' }]),
      });

      await expect(
        AuditPlanService.create('audit_plans', { year: 2025, title: 'Test' })
      ).rejects.toThrow(ConflictError);
    });

    it('should throw ConflictError when previous year plan is not archived', async () => {
      // No plan for same year
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });
      // Previous year has unarchived plan
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'prev', title: 'Old Plan' }]),
      });

      await expect(
        AuditPlanService.create('audit_plans', { year: 2025, title: 'Test' })
      ).rejects.toThrow(ConflictError);
    });

    it('should generate plan_code via NumberingService', async () => {
      setupCreateMocks();

      await AuditPlanService.create('audit_plans', {
        year: 2025,
        title: 'Test Plan',
        department: 'IT',
      });

      expect(NumberingService.nextPlanCode).toHaveBeenCalledWith(2025);
    });

    it('should set default dates to fiscal year bounds', async () => {
      setupCreateMocks();

      const result = await AuditPlanService.create('audit_plans', {
        year: 2025,
        title: 'Test Plan',
        department: 'IT',
      });

      expect(result.planned_start_date).toBe('2025-01-01');
      expect(result.planned_end_date).toBe('2025-12-31');
    });

    it('should allow custom dates to override defaults', async () => {
      setupCreateMocks();

      const result = await AuditPlanService.create('audit_plans', {
        year: 2025,
        title: 'Test Plan',
        department: 'IT',
        planned_start_date: '2025-03-01',
        planned_end_date: '2025-06-30',
      });

      expect(result.planned_start_date).toBe('2025-03-01');
      expect(result.planned_end_date).toBe('2025-06-30');
    });

    it('should set initial status to Planned', async () => {
      setupCreateMocks();

      const result = await AuditPlanService.create('audit_plans', {
        year: 2025,
        title: 'Test Plan',
        department: 'IT',
      });

      expect(result.status).toBe('Planned');
    });

    it('should set is_archived to false', async () => {
      setupCreateMocks();

      const result = await AuditPlanService.create('audit_plans', {
        year: 2025,
        title: 'Test Plan',
        department: 'IT',
      });

      expect(result.is_archived).toBe(false);
    });

    it('should set plan_code from NumberingService', async () => {
      setupCreateMocks();

      const result = await AuditPlanService.create('audit_plans', {
        year: 2025,
        title: 'Test Plan',
        department: 'IT',
      });

      expect(result.plan_code).toBe('IA-PL-25-001');
    });
  });

  describe('closePlan', () => {
    const planId = 'plan-uuid-123';
    const userId = 'user-uuid-456';

    it('should throw ForbiddenError when user does not exist', async () => {
      // User query returns null
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });

      await expect(
        AuditPlanService.closePlan(planId, userId)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when user role is Internal Auditor', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: userId, role: 'Internal Auditor' }),
      });

      await expect(
        AuditPlanService.closePlan(planId, userId)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when user role is Viewer', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: userId, role: 'Viewer' }),
      });

      await expect(
        AuditPlanService.closePlan(planId, userId)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw NotFoundError when plan does not exist', async () => {
      // User is Manager
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: userId, role: 'Manager' }),
      });
      // Plan query returns null
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(null),
      });

      await expect(
        AuditPlanService.closePlan(planId, userId)
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw ValidationError when open recommendations exist', async () => {
      // User is Manager
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: userId, role: 'Manager' }),
      });
      // Plan exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: planId, status: 'Reporting' }),
      });
      // Open recommendations count = 3
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 3 }),
      });

      await expect(
        AuditPlanService.closePlan(planId, userId)
      ).rejects.toThrow(ValidationError);
    });

    it('should include open recommendations count in ValidationError details', async () => {
      // User is Manager
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: userId, role: 'Manager' }),
      });
      // Plan exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: planId, status: 'Reporting' }),
      });
      // Open recommendations count = 5
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 5 }),
      });

      try {
        await AuditPlanService.closePlan(planId, userId);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.details).toEqual({ openRecommendationsCount: 5 });
        expect(error.message).toContain('5');
      }
    });

    it('should close plan successfully when user is Manager and all recommendations are closed', async () => {
      // User is Manager
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: userId, role: 'Manager' }),
      });
      // Plan exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: planId, status: 'Reporting' }),
      });
      // No open recommendations
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // UPDATE plan status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      const result = await AuditPlanService.closePlan(planId, userId);

      expect(result).toEqual({ success: true, planId });
    });

    it('should close plan successfully when user is Admin', async () => {
      // User is Admin
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: userId, role: 'Admin' }),
      });
      // Plan exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: planId, status: 'Fieldwork' }),
      });
      // No open recommendations
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // UPDATE plan status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      const result = await AuditPlanService.closePlan(planId, userId);

      expect(result).toEqual({ success: true, planId });
    });

    it('should allow closure when plan has no findings (and thus no recommendations)', async () => {
      // User is Manager
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: userId, role: 'Manager' }),
      });
      // Plan exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: planId, status: 'Planned' }),
      });
      // No open recommendations (count = 0 because no findings exist)
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // UPDATE plan status
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      const result = await AuditPlanService.closePlan(planId, userId);

      expect(result).toEqual({ success: true, planId });
    });

    it('should update plan status to Closed via db.prepare UPDATE', async () => {
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });

      // User is Manager
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: userId, role: 'Manager' }),
      });
      // Plan exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: planId, status: 'Reporting' }),
      });
      // No open recommendations
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ count: 0 }),
      });
      // UPDATE plan status - capture the call
      mockDb.prepare.mockReturnValueOnce({
        run: mockRun,
      });

      await AuditPlanService.closePlan(planId, userId);

      // Verify the UPDATE was called with the planId
      expect(mockRun).toHaveBeenCalledWith(planId);
      // Verify the SQL contains 'Closed'
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('Closed')
      );
    });
  });
});
