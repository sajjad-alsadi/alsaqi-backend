// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { Router } from 'express';

/**
 * Regression Test: Custom Route Modules Still Mount Correctly
 *
 * After removing dead CRUD generator calls, these custom route factories
 * must continue to work without errors. Each factory is called with minimal
 * mock dependencies and verified to return a functioning Express Router.
 *
 * Validates: Requirements 5.4
 */

// Mock services that are imported inside route factories to prevent real DB calls
vi.mock('../../services/AuditTaskService', () => ({
  AuditTaskService: {
    changeStatus: vi.fn(),
    assignUsers: vi.fn(),
    unassignUser: vi.fn(),
    getTasks: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../services/AuditProgramService', () => ({
  AuditProgramService: {
    duplicate: vi.fn(),
    approveProgram: vi.fn(),
  },
}));

vi.mock('../../services/RecommendationService', () => ({
  RecommendationService: {
    getRecommendations: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../services/AuditService', () => ({
  AuditService: {
    getFindings: vi.fn().mockResolvedValue([]),
    getFindingsByPlan: vi.fn().mockResolvedValue([]),
    createFinding: vi.fn(),
    updateFinding: vi.fn(),
    changeFindingStatus: vi.fn(),
    deleteFinding: vi.fn(),
  },
}));

vi.mock('../../services/ComplianceService', () => ({
  ComplianceService: {
    getAll: vi.fn().mockResolvedValue([]),
    getSummary: vi.fn().mockResolvedValue({}),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  },
}));

vi.mock('../../services/BaseService', () => ({
  BaseService: {
    findAll: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../services/AuthService', () => ({
  AuthService: {
    logAudit: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../services/NotificationService', () => ({
  NotificationService: {
    create: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('../../services/EvidenceStorageService', () => ({
  EvidenceStorageService: {
    attachEvidence: vi.fn().mockResolvedValue({}),
  },
}));

// Import route factories
import { createAuditTaskRoutes } from '../auditTasks';
import { createAuditProgramRoutes } from '../auditPrograms';
import { createRecommendationRoutes } from '../recommendations';
import { createAuditFindingRoutes } from '../auditFindings';
import { createComplianceRoutes } from '../compliance';

// Minimal mock dependencies
const mockDb = {
  prepare: vi.fn(() => ({
    get: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ changes: 0 }),
  })),
  exec: vi.fn(),
  transaction: vi.fn((fn: any) => fn),
};

const mockAuthenticate = vi.fn((_req: any, _res: any, next: any) => next());
const mockCheckPermission = vi.fn((_module: string, _action: string) =>
  (_req: any, _res: any, next: any) => next()
);
const mockLogError = vi.fn().mockResolvedValue(undefined);
const mockSaveFile = vi.fn().mockResolvedValue('/uploads/test-file.pdf');

describe('Custom Route Modules - Regression Test (Task 6.2)', () => {
  describe('createAuditTaskRoutes', () => {
    it('should return a Router instance without throwing', () => {
      const router = createAuditTaskRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError);
      expect(router).toBeDefined();
      expect(typeof router).toBe('function'); // Express routers are functions
    });

    it('should have routes registered on the router', () => {
      const router = createAuditTaskRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError);
      // Express Router stores routes in router.stack
      const stack = (router as any).stack;
      expect(stack.length).toBeGreaterThan(0);
    });
  });

  describe('createAuditProgramRoutes', () => {
    it('should return a Router instance without throwing', () => {
      const router = createAuditProgramRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError);
      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
    });

    it('should have routes registered on the router', () => {
      const router = createAuditProgramRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError);
      const stack = (router as any).stack;
      expect(stack.length).toBeGreaterThan(0);
    });
  });

  describe('createRecommendationRoutes', () => {
    it('should return a Router instance without throwing', () => {
      const router = createRecommendationRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError);
      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
    });

    it('should have routes registered on the router', () => {
      const router = createRecommendationRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError);
      const stack = (router as any).stack;
      expect(stack.length).toBeGreaterThan(0);
    });
  });

  describe('createAuditFindingRoutes', () => {
    it('should return a Router instance without throwing', () => {
      const router = createAuditFindingRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError);
      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
    });

    it('should have routes registered on the router', () => {
      const router = createAuditFindingRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError);
      const stack = (router as any).stack;
      expect(stack.length).toBeGreaterThan(0);
    });
  });

  describe('createComplianceRoutes', () => {
    it('should return a Router instance without throwing', () => {
      const router = createComplianceRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError, mockSaveFile);
      expect(router).toBeDefined();
      expect(typeof router).toBe('function');
    });

    it('should have routes registered on the router', () => {
      const router = createComplianceRoutes(mockDb, mockAuthenticate, mockCheckPermission, mockLogError, mockSaveFile);
      const stack = (router as any).stack;
      expect(stack.length).toBeGreaterThan(0);
    });
  });
});
