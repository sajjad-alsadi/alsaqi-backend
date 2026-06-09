// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the db module
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
      transaction: vi.fn((fn: Function) => fn()),
      validateIdentifier: vi.fn((id: string) => id),
    },
  };
});

// Mock NotificationService
vi.mock('../NotificationService', () => ({
  NotificationService: {
    create: vi.fn().mockResolvedValue(true),
    getAdminIds: vi.fn().mockResolvedValue(['admin-id-1']),
  },
}));

// Mock N8nService
vi.mock('../../utils/n8nService', () => ({
  N8nService: {
    sendEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

import { RecommendationService } from '../RecommendationService';
import { db } from '../../db/index';

describe('RecommendationService.getRecommendations', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupMocks(total: number, data: any[]) {
    // COUNT query
    mockDb.prepare.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue({ total }),
    });
    // SELECT data query
    mockDb.prepare.mockReturnValueOnce({
      all: vi.fn().mockResolvedValue(data),
    });
  }

  describe('pagination defaults', () => {
    it('should use default pageSize of 20 when not specified', async () => {
      setupMocks(0, []);

      const result = await RecommendationService.getRecommendations({});

      expect(result.pagination.pageSize).toBe(20);
      expect(result.pagination.page).toBe(1);
    });

    it('should use default page of 1 when not specified', async () => {
      setupMocks(0, []);

      const result = await RecommendationService.getRecommendations({});

      expect(result.pagination.page).toBe(1);
    });

    it('should cap pageSize at 100', async () => {
      setupMocks(0, []);

      const result = await RecommendationService.getRecommendations({ pageSize: 200 });

      expect(result.pagination.pageSize).toBe(100);
    });

    it('should accept pageSize of 100', async () => {
      setupMocks(0, []);

      const result = await RecommendationService.getRecommendations({ pageSize: 100 });

      expect(result.pagination.pageSize).toBe(100);
    });

    it('should use default pageSize when pageSize is less than 1', async () => {
      setupMocks(0, []);

      const result = await RecommendationService.getRecommendations({ pageSize: 0 });

      expect(result.pagination.pageSize).toBe(20);
    });

    it('should calculate totalPages correctly', async () => {
      setupMocks(45, []);

      const result = await RecommendationService.getRecommendations({ pageSize: 20 });

      expect(result.pagination.totalPages).toBe(3);
      expect(result.pagination.total).toBe(45);
    });
  });

  describe('filtering', () => {
    it('should filter by department', async () => {
      const mockData = [{ id: 'rec-1', department: 'IT', status: 'Open' }];
      setupMocks(1, mockData);

      const result = await RecommendationService.getRecommendations({ department: 'IT' });

      expect(result.data).toEqual(mockData);

      // Verify the SQL includes department filter
      const countSql = mockDb.prepare.mock.calls[0][0];
      expect(countSql).toContain('department = ');
    });

    it('should filter by plan_id', async () => {
      const mockData = [{ id: 'rec-1', plan_id: 'plan-001', status: 'Open' }];
      setupMocks(1, mockData);

      const result = await RecommendationService.getRecommendations({ plan_id: 'plan-001' });

      expect(result.data).toEqual(mockData);

      // Verify the SQL includes plan_id filter
      const countSql = mockDb.prepare.mock.calls[0][0];
      expect(countSql).toContain('plan_id = ');
    });

    it('should filter by status', async () => {
      const mockData = [{ id: 'rec-1', status: 'In Progress' }];
      setupMocks(1, mockData);

      const result = await RecommendationService.getRecommendations({ status: 'In Progress' });

      expect(result.data).toEqual(mockData);

      // Verify the SQL includes status filter
      const countSql = mockDb.prepare.mock.calls[0][0];
      expect(countSql).toContain('status = ');
    });

    it('should combine multiple filters', async () => {
      setupMocks(0, []);

      await RecommendationService.getRecommendations({
        department: 'Finance',
        plan_id: 'plan-002',
        status: 'Open',
      });

      const countSql = mockDb.prepare.mock.calls[0][0];
      expect(countSql).toContain('department = ');
      expect(countSql).toContain('plan_id = ');
      expect(countSql).toContain('status = ');
    });
  });

  describe('archived plan exclusion', () => {
    it('should exclude recommendations from archived plans', async () => {
      setupMocks(0, []);

      await RecommendationService.getRecommendations({});

      // Verify the SQL excludes archived plans
      const countSql = mockDb.prepare.mock.calls[0][0];
      expect(countSql).toContain('plan_id NOT IN (SELECT id FROM audit_plans WHERE is_archived = true)');

      const dataSql = mockDb.prepare.mock.calls[1][0];
      expect(dataSql).toContain('plan_id NOT IN (SELECT id FROM audit_plans WHERE is_archived = true)');
    });

    it('should always exclude archived plans even with other filters', async () => {
      setupMocks(0, []);

      await RecommendationService.getRecommendations({ department: 'IT', status: 'Open' });

      const countSql = mockDb.prepare.mock.calls[0][0];
      expect(countSql).toContain('plan_id NOT IN (SELECT id FROM audit_plans WHERE is_archived = true)');
      expect(countSql).toContain('department = ');
      expect(countSql).toContain('status = ');
    });
  });

  describe('return structure', () => {
    it('should return data and pagination metadata', async () => {
      const mockData = [
        { id: 'rec-1', status: 'Open' },
        { id: 'rec-2', status: 'In Progress' },
      ];
      setupMocks(2, mockData);

      const result = await RecommendationService.getRecommendations({});

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('pagination');
      expect(result.data).toEqual(mockData);
      expect(result.pagination).toEqual({
        total: 2,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      });
    });

    it('should return empty data array when no results', async () => {
      setupMocks(0, []);

      const result = await RecommendationService.getRecommendations({});

      expect(result.data).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
    });

    it('should handle string page and pageSize values', async () => {
      setupMocks(50, []);

      const result = await RecommendationService.getRecommendations({
        page: '2' as any,
        pageSize: '10' as any,
      });

      expect(result.pagination.page).toBe(2);
      expect(result.pagination.pageSize).toBe(10);
    });
  });
});
