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

// Mock NotificationService
vi.mock('../NotificationService', () => ({
  NotificationService: {
    create: vi.fn().mockResolvedValue(true),
    getAdminIds: vi.fn().mockResolvedValue([]),
  },
}));

import { AuditProgramService } from '../AuditProgramService';
import { NotificationService } from '../NotificationService';
import { db } from '../../db/index';
import { ForbiddenError, ValidationError, NotFoundError } from '../../utils/errors';
import { UserRole } from '@alsaqi/shared';

describe('AuditProgramService', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createProgram', () => {
    const validData = {
      program_code: 'PRG-001',
      program_title: 'Test Program',
      audit_area: 'Finance',
      department: 'IT',
      audit_type: 'Operational',
      audit_objective: 'Test objective',
      audit_scope: 'Test scope',
      risk_ids: ['risk-1', 'risk-2'],
      compliance_item_ids: ['comp-1'],
    };

    const userId = 'user-uuid-123';

    function setupSuccessMocks() {
      // Validate risk_ids exist in risk_register
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'risk-1' }, { id: 'risk-2' }]),
      });
      // Validate compliance_item_ids exist in compliance_items
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'comp-1' }]),
      });
      // INSERT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'new-program-id' }),
      });
      // INSERT risk link 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });
      // INSERT risk link 2
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });
      // INSERT compliance link 1
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });
      // SELECT Manager/Admin users for notification
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'manager-1' }, { id: 'admin-1' }]),
      });
    }

    // === Role restriction tests ===

    it('should throw ForbiddenError when user role is not Internal Auditor', async () => {
      await expect(
        AuditProgramService.createProgram(validData, userId, UserRole.MANAGER)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when user role is Admin', async () => {
      await expect(
        AuditProgramService.createProgram(validData, userId, UserRole.ADMIN)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when user role is Viewer', async () => {
      await expect(
        AuditProgramService.createProgram(validData, userId, UserRole.VIEWER)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when user role is Compliance Officer', async () => {
      await expect(
        AuditProgramService.createProgram(validData, userId, UserRole.COMPLIANCE_OFFICER)
      ).rejects.toThrow(ForbiddenError);
    });

    // === Validation tests: risk_ids ===

    it('should throw ValidationError when risk_ids exceeds 200', async () => {
      const tooManyRisks = Array.from({ length: 201 }, (_, i) => `risk-${i}`);
      const data = { ...validData, risk_ids: tooManyRisks };

      await expect(
        AuditProgramService.createProgram(data, userId, UserRole.INTERNAL_AUDITOR)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when risk_ids contains duplicates', async () => {
      const data = { ...validData, risk_ids: ['risk-1', 'risk-2', 'risk-1'] };

      await expect(
        AuditProgramService.createProgram(data, userId, UserRole.INTERNAL_AUDITOR)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when risk_ids reference non-existent risks', async () => {
      // risk_register returns only risk-1 (risk-2 is missing)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'risk-1' }]),
      });

      await expect(
        AuditProgramService.createProgram(validData, userId, UserRole.INTERNAL_AUDITOR)
      ).rejects.toThrow(ValidationError);
    });

    it('should include missing risk IDs in ValidationError details', async () => {
      // risk_register returns only risk-1 (risk-2 is missing)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'risk-1' }]),
      });

      try {
        await AuditProgramService.createProgram(validData, userId, UserRole.INTERNAL_AUDITOR);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.details.missing).toContain('risk-2');
      }
    });

    // === Validation tests: compliance_item_ids ===

    it('should throw ValidationError when compliance_item_ids exceeds 200', async () => {
      const tooManyCompliance = Array.from({ length: 201 }, (_, i) => `comp-${i}`);
      const data = { ...validData, compliance_item_ids: tooManyCompliance };

      await expect(
        AuditProgramService.createProgram(data, userId, UserRole.INTERNAL_AUDITOR)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when compliance_item_ids contains duplicates', async () => {
      const data = { ...validData, compliance_item_ids: ['comp-1', 'comp-2', 'comp-1'] };

      await expect(
        AuditProgramService.createProgram(data, userId, UserRole.INTERNAL_AUDITOR)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when compliance_item_ids reference non-existent items', async () => {
      // risk_register returns all risks (valid)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'risk-1' }, { id: 'risk-2' }]),
      });
      // compliance_items returns empty (comp-1 is missing)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      await expect(
        AuditProgramService.createProgram(validData, userId, UserRole.INTERNAL_AUDITOR)
      ).rejects.toThrow(ValidationError);
    });

    it('should include missing compliance IDs in ValidationError details', async () => {
      // risk_register returns all risks (valid)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'risk-1' }, { id: 'risk-2' }]),
      });
      // compliance_items returns empty (comp-1 is missing)
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      try {
        await AuditProgramService.createProgram(validData, userId, UserRole.INTERNAL_AUDITOR);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.details.missing).toContain('comp-1');
      }
    });

    // === Successful creation tests ===

    it('should create program with status Draft and version_number 1', async () => {
      setupSuccessMocks();

      const result = await AuditProgramService.createProgram(validData, userId, UserRole.INTERNAL_AUDITOR);

      expect(result).toEqual({ programId: 'new-program-id' });

      // Verify the INSERT SQL contains 'Draft' and 1 for version_number
      const insertCall = mockDb.prepare.mock.calls.find(
        (call: any[]) => call[0]?.includes('INSERT INTO audit_programs')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[0]).toContain('Draft');
    });

    it('should create risk links for each risk_id', async () => {
      setupSuccessMocks();

      await AuditProgramService.createProgram(validData, userId, UserRole.INTERNAL_AUDITOR);

      // Verify risk link inserts were called
      const riskLinkCalls = mockDb.prepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('program_risk_links')
      );
      expect(riskLinkCalls.length).toBe(2); // risk-1 and risk-2
    });

    it('should create compliance links for each compliance_item_id', async () => {
      setupSuccessMocks();

      await AuditProgramService.createProgram(validData, userId, UserRole.INTERNAL_AUDITOR);

      // Verify compliance link inserts were called
      const complianceLinkCalls = mockDb.prepare.mock.calls.filter(
        (call: any[]) => call[0]?.includes('program_compliance_links')
      );
      expect(complianceLinkCalls.length).toBe(1); // comp-1
    });

    it('should send notification to Manager and Admin users', async () => {
      setupSuccessMocks();

      await AuditProgramService.createProgram(validData, userId, UserRole.INTERNAL_AUDITOR);

      expect(NotificationService.create).toHaveBeenCalledWith(
        ['manager-1', 'admin-1'],
        'record_created',
        expect.stringContaining('programPendingApproval'),
        'AuditProgramLibrary',
        '/library',
        expect.objectContaining({
          actorId: userId,
          entityId: 'new-program-id',
          entityType: 'audit_program',
        })
      );
    });

    it('should succeed with empty risk_ids and compliance_item_ids', async () => {
      const dataNoLinks = { ...validData, risk_ids: [], compliance_item_ids: [] };

      // INSERT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'new-program-id' }),
      });
      // SELECT Manager/Admin users for notification
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([{ id: 'manager-1' }]),
      });

      const result = await AuditProgramService.createProgram(dataNoLinks, userId, UserRole.INTERNAL_AUDITOR);

      expect(result).toEqual({ programId: 'new-program-id' });
    });

    it('should succeed with undefined risk_ids and compliance_item_ids', async () => {
      const dataNoLinks = {
        program_code: 'PRG-001',
        program_title: 'Test Program',
        audit_area: 'Finance',
        department: 'IT',
        audit_type: 'Operational',
        audit_objective: 'Test objective',
        audit_scope: 'Test scope',
      };

      // INSERT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'new-program-id' }),
      });
      // SELECT Manager/Admin users for notification
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      const result = await AuditProgramService.createProgram(dataNoLinks, userId, UserRole.INTERNAL_AUDITOR);

      expect(result).toEqual({ programId: 'new-program-id' });
    });

    it('should not send notification when no Manager/Admin users exist', async () => {
      const dataNoLinks = { ...validData, risk_ids: [], compliance_item_ids: [] };

      // INSERT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'new-program-id' }),
      });
      // SELECT Manager/Admin users - empty
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      await AuditProgramService.createProgram(dataNoLinks, userId, UserRole.INTERNAL_AUDITOR);

      expect(NotificationService.create).not.toHaveBeenCalled();
    });

    it('should accept exactly 200 risk_ids without error', async () => {
      const maxRisks = Array.from({ length: 200 }, (_, i) => `risk-${i}`);
      const data = { ...validData, risk_ids: maxRisks, compliance_item_ids: [] };

      // Validate risk_ids exist
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue(maxRisks.map(id => ({ id }))),
      });
      // INSERT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'new-program-id' }),
      });
      // 200 risk link inserts
      for (let i = 0; i < 200; i++) {
        mockDb.prepare.mockReturnValueOnce({
          run: vi.fn().mockResolvedValue({ changes: 1 }),
        });
      }
      // SELECT Manager/Admin users
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      const result = await AuditProgramService.createProgram(data, userId, UserRole.INTERNAL_AUDITOR);

      expect(result).toEqual({ programId: 'new-program-id' });
    });

    it('should accept exactly 200 compliance_item_ids without error', async () => {
      const maxCompliance = Array.from({ length: 200 }, (_, i) => `comp-${i}`);
      const data = { ...validData, risk_ids: [], compliance_item_ids: maxCompliance };

      // Validate compliance_item_ids exist
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue(maxCompliance.map(id => ({ id }))),
      });
      // INSERT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: 'new-program-id' }),
      });
      // 200 compliance link inserts
      for (let i = 0; i < 200; i++) {
        mockDb.prepare.mockReturnValueOnce({
          run: vi.fn().mockResolvedValue({ changes: 1 }),
        });
      }
      // SELECT Manager/Admin users
      mockDb.prepare.mockReturnValueOnce({
        all: vi.fn().mockResolvedValue([]),
      });

      const result = await AuditProgramService.createProgram(data, userId, UserRole.INTERNAL_AUDITOR);

      expect(result).toEqual({ programId: 'new-program-id' });
    });
  });

  describe('approveProgram', () => {
    const programId = 'program-uuid-123';
    const userId = 'user-uuid-456';

    // === Permission validation tests ===

    it('should throw ForbiddenError when user role is Internal Auditor (no APPROVE permission)', async () => {
      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.INTERNAL_AUDITOR)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when user role is Viewer', async () => {
      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.VIEWER)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when user role is Compliance Officer', async () => {
      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.COMPLIANCE_OFFICER)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError when user role is Risk Officer', async () => {
      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.RISK_OFFICER)
      ).rejects.toThrow(ForbiddenError);
    });

    it('should throw ForbiddenError with descriptive message when user lacks permission', async () => {
      try {
        await AuditProgramService.approveProgram(programId, userId, UserRole.INTERNAL_AUDITOR);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(ForbiddenError);
        expect(error.message).toContain('صلاحية اعتماد');
      }
    });

    // === NotFoundError tests ===

    it('should throw NotFoundError when program does not exist (Manager role)', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.MANAGER)
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError when program does not exist (Admin role)', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.ADMIN)
      ).rejects.toThrow(NotFoundError);
    });

    // === Status validation tests ===

    it('should throw ValidationError when program status is Active', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: programId, status: 'Active' }),
      });

      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.MANAGER)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when program status is Approved', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: programId, status: 'Approved' }),
      });

      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.MANAGER)
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when program status is Archived', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: programId, status: 'Archived' }),
      });

      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.MANAGER)
      ).rejects.toThrow(ValidationError);
    });

    it('should include current status and allowed statuses in ValidationError details', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: programId, status: 'Active' }),
      });

      try {
        await AuditProgramService.approveProgram(programId, userId, UserRole.MANAGER);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.details.currentStatus).toBe('Active');
        expect(error.details.allowedStatuses).toContain('Draft');
        expect(error.details.allowedStatuses).toContain('Submitted');
      }
    });

    // === Successful approval tests ===

    it('should approve program with Draft status when user is Manager', async () => {
      // SELECT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: programId, status: 'Draft' }),
      });
      // UPDATE program
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.MANAGER)
      ).resolves.toBeUndefined();
    });

    it('should approve program with Submitted status when user is Manager', async () => {
      // SELECT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: programId, status: 'Submitted' }),
      });
      // UPDATE program
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.MANAGER)
      ).resolves.toBeUndefined();
    });

    it('should approve program with Draft status when user is Admin', async () => {
      // SELECT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: programId, status: 'Draft' }),
      });
      // UPDATE program
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.ADMIN)
      ).resolves.toBeUndefined();
    });

    it('should approve program with Submitted status when user is Admin', async () => {
      // SELECT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: programId, status: 'Submitted' }),
      });
      // UPDATE program
      mockDb.prepare.mockReturnValueOnce({
        run: vi.fn().mockResolvedValue({ changes: 1 }),
      });

      await expect(
        AuditProgramService.approveProgram(programId, userId, UserRole.ADMIN)
      ).resolves.toBeUndefined();
    });

    it('should set status to Approved and record approved_by and approved_at', async () => {
      // SELECT program
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({ id: programId, status: 'Draft' }),
      });
      // UPDATE program
      const mockRun = vi.fn().mockResolvedValue({ changes: 1 });
      mockDb.prepare.mockReturnValueOnce({ run: mockRun });

      await AuditProgramService.approveProgram(programId, userId, UserRole.MANAGER);

      // Verify the UPDATE SQL sets status, approved_by, and approved_at
      const updateCall = mockDb.prepare.mock.calls.find(
        (call: any[]) => call[0]?.includes('UPDATE audit_programs') && call[0]?.includes('Approved')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[0]).toContain('approved_by');
      expect(updateCall[0]).toContain('approved_at');
      expect(mockRun).toHaveBeenCalledWith(userId, programId);
    });
  });
});
