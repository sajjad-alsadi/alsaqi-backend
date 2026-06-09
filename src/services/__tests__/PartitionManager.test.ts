import { describe, it, expect } from 'vitest';
import {
  getPartitionName,
  getPartitionDateRange,
  getPartitionsToDropByRetention,
  parsePartitionName,
  PartitionInfo,
} from '../PartitionManager';

describe('PartitionManager', () => {
  describe('getPartitionName', () => {
    it('should generate correct partition name for January 2024', () => {
      const date = new Date(Date.UTC(2024, 0, 1)); // January 2024
      expect(getPartitionName(date)).toBe('audit_trail_y2024m01');
    });

    it('should generate correct partition name for December 2025', () => {
      const date = new Date(Date.UTC(2025, 11, 15)); // December 2025
      expect(getPartitionName(date)).toBe('audit_trail_y2025m12');
    });

    it('should generate correct partition name for single-digit months with zero padding', () => {
      const date = new Date(Date.UTC(2024, 2, 10)); // March 2024
      expect(getPartitionName(date)).toBe('audit_trail_y2024m03');
    });

    it('should generate correct partition name for October (double-digit month)', () => {
      const date = new Date(Date.UTC(2024, 9, 1)); // October 2024
      expect(getPartitionName(date)).toBe('audit_trail_y2024m10');
    });

    it('should handle year boundaries correctly', () => {
      const dec = new Date(Date.UTC(2024, 11, 31)); // Dec 31, 2024
      const jan = new Date(Date.UTC(2025, 0, 1)); // Jan 1, 2025
      expect(getPartitionName(dec)).toBe('audit_trail_y2024m12');
      expect(getPartitionName(jan)).toBe('audit_trail_y2025m01');
    });
  });

  describe('getPartitionDateRange', () => {
    it('should return correct start and end for January 2024', () => {
      const date = new Date(Date.UTC(2024, 0, 15)); // mid-January
      const { startDate, endDate } = getPartitionDateRange(date);

      expect(startDate.toISOString()).toBe('2024-01-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    });

    it('should return correct start and end for December 2024', () => {
      const date = new Date(Date.UTC(2024, 11, 25)); // December
      const { startDate, endDate } = getPartitionDateRange(date);

      expect(startDate.toISOString()).toBe('2024-12-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    });

    it('should return correct range for February (leap year)', () => {
      const date = new Date(Date.UTC(2024, 1, 10)); // Feb 2024 (leap year)
      const { startDate, endDate } = getPartitionDateRange(date);

      expect(startDate.toISOString()).toBe('2024-02-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    });

    it('should return correct range for February (non-leap year)', () => {
      const date = new Date(Date.UTC(2023, 1, 10)); // Feb 2023 (non-leap)
      const { startDate, endDate } = getPartitionDateRange(date);

      expect(startDate.toISOString()).toBe('2023-02-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2023-03-01T00:00:00.000Z');
    });

    it('should always have start as 1st of month and end as 1st of next month', () => {
      for (let month = 0; month < 12; month++) {
        const date = new Date(Date.UTC(2024, month, 15));
        const { startDate, endDate } = getPartitionDateRange(date);

        expect(startDate.getUTCDate()).toBe(1);
        expect(startDate.getUTCMonth()).toBe(month);
        expect(endDate.getUTCDate()).toBe(1);
        expect(endDate.getUTCMonth()).toBe((month + 1) % 12);
      }
    });
  });

  describe('getPartitionsToDropByRetention', () => {
    it('should identify partitions older than retention period for dropping', () => {
      const referenceDate = new Date(Date.UTC(2024, 5, 15)); // June 2024
      const retentionMonths = 24; // Keep 2 years

      const partitions: PartitionInfo[] = [
        { name: 'audit_trail_y2022m01', startDate: new Date(Date.UTC(2022, 0, 1)), endDate: new Date(Date.UTC(2022, 1, 1)) },
        { name: 'audit_trail_y2022m05', startDate: new Date(Date.UTC(2022, 4, 1)), endDate: new Date(Date.UTC(2022, 5, 1)) },
        { name: 'audit_trail_y2022m06', startDate: new Date(Date.UTC(2022, 5, 1)), endDate: new Date(Date.UTC(2022, 6, 1)) },
        { name: 'audit_trail_y2023m01', startDate: new Date(Date.UTC(2023, 0, 1)), endDate: new Date(Date.UTC(2023, 1, 1)) },
        { name: 'audit_trail_y2024m05', startDate: new Date(Date.UTC(2024, 4, 1)), endDate: new Date(Date.UTC(2024, 5, 1)) },
      ];

      const toDrop = getPartitionsToDropByRetention(partitions, retentionMonths, referenceDate);

      // Cutoff: June 2024 - 24 months = June 2022
      // Partitions with endDate <= 2022-06-01 should be dropped
      expect(toDrop.map((p) => p.name)).toEqual([
        'audit_trail_y2022m01',
        'audit_trail_y2022m05',
      ]);
    });

    it('should return empty array when no partitions are older than retention', () => {
      const referenceDate = new Date(Date.UTC(2024, 5, 15)); // June 2024
      const retentionMonths = 24;

      const partitions: PartitionInfo[] = [
        { name: 'audit_trail_y2023m01', startDate: new Date(Date.UTC(2023, 0, 1)), endDate: new Date(Date.UTC(2023, 1, 1)) },
        { name: 'audit_trail_y2024m05', startDate: new Date(Date.UTC(2024, 4, 1)), endDate: new Date(Date.UTC(2024, 5, 1)) },
      ];

      const toDrop = getPartitionsToDropByRetention(partitions, retentionMonths, referenceDate);
      expect(toDrop).toEqual([]);
    });

    it('should drop all partitions when retention is 0', () => {
      const referenceDate = new Date(Date.UTC(2024, 5, 15)); // June 2024
      const retentionMonths = 0;

      const partitions: PartitionInfo[] = [
        { name: 'audit_trail_y2024m04', startDate: new Date(Date.UTC(2024, 3, 1)), endDate: new Date(Date.UTC(2024, 4, 1)) },
        { name: 'audit_trail_y2024m05', startDate: new Date(Date.UTC(2024, 4, 1)), endDate: new Date(Date.UTC(2024, 5, 1)) },
      ];

      const toDrop = getPartitionsToDropByRetention(partitions, retentionMonths, referenceDate);
      // Cutoff: June 2024 - 0 months = June 2024
      // Partitions with endDate <= 2024-06-01 should be dropped
      expect(toDrop.map((p) => p.name)).toEqual([
        'audit_trail_y2024m04',
        'audit_trail_y2024m05',
      ]);
    });

    it('should handle retention of 12 months correctly', () => {
      const referenceDate = new Date(Date.UTC(2024, 11, 1)); // December 2024
      const retentionMonths = 12;

      const partitions: PartitionInfo[] = [
        { name: 'audit_trail_y2023m10', startDate: new Date(Date.UTC(2023, 9, 1)), endDate: new Date(Date.UTC(2023, 10, 1)) },
        { name: 'audit_trail_y2023m11', startDate: new Date(Date.UTC(2023, 10, 1)), endDate: new Date(Date.UTC(2023, 11, 1)) },
        { name: 'audit_trail_y2023m12', startDate: new Date(Date.UTC(2023, 11, 1)), endDate: new Date(Date.UTC(2024, 0, 1)) },
        { name: 'audit_trail_y2024m01', startDate: new Date(Date.UTC(2024, 0, 1)), endDate: new Date(Date.UTC(2024, 1, 1)) },
      ];

      const toDrop = getPartitionsToDropByRetention(partitions, retentionMonths, referenceDate);
      // Cutoff: Dec 2024 - 12 months = Dec 2023
      // Partitions with endDate <= 2023-12-01 should be dropped
      expect(toDrop.map((p) => p.name)).toEqual([
        'audit_trail_y2023m10',
        'audit_trail_y2023m11',
      ]);
    });

    it('should not drop the partition at the exact cutoff boundary', () => {
      const referenceDate = new Date(Date.UTC(2024, 5, 1)); // June 2024
      const retentionMonths = 6;

      const partitions: PartitionInfo[] = [
        // Cutoff: June 2024 - 6 months = December 2023
        // This partition ends exactly at the cutoff (endDate = 2023-12-01)
        { name: 'audit_trail_y2023m11', startDate: new Date(Date.UTC(2023, 10, 1)), endDate: new Date(Date.UTC(2023, 11, 1)) },
        // This partition ends after the cutoff
        { name: 'audit_trail_y2023m12', startDate: new Date(Date.UTC(2023, 11, 1)), endDate: new Date(Date.UTC(2024, 0, 1)) },
      ];

      const toDrop = getPartitionsToDropByRetention(partitions, retentionMonths, referenceDate);
      // Only audit_trail_y2023m11 has endDate (2023-12-01) <= cutoff (2023-12-01)
      expect(toDrop.map((p) => p.name)).toEqual(['audit_trail_y2023m11']);
    });
  });

  describe('parsePartitionName', () => {
    it('should parse a valid partition name', () => {
      const date = parsePartitionName('audit_trail_y2024m03');
      expect(date).not.toBeNull();
      expect(date!.getUTCFullYear()).toBe(2024);
      expect(date!.getUTCMonth()).toBe(2); // March (0-indexed)
    });

    it('should return null for invalid partition names', () => {
      expect(parsePartitionName('invalid_name')).toBeNull();
      expect(parsePartitionName('audit_trail_2024m03')).toBeNull();
      expect(parsePartitionName('audit_trail_y2024')).toBeNull();
      expect(parsePartitionName('')).toBeNull();
    });

    it('should parse all months correctly', () => {
      for (let month = 1; month <= 12; month++) {
        const name = `audit_trail_y2024m${String(month).padStart(2, '0')}`;
        const date = parsePartitionName(name);
        expect(date).not.toBeNull();
        expect(date!.getUTCMonth()).toBe(month - 1);
      }
    });
  });
});
