// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  parsePaginationParams,
  computePaginationMeta,
  paginateQuery,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../paginationService';
import { ValidationError } from '../errors';

describe('paginationService', () => {
  // ─── parsePaginationParams ───────────────────────────────────────────────

  describe('parsePaginationParams', () => {
    describe('defaults', () => {
      it('returns default page=1, pageSize=20 when no params provided', () => {
        const result = parsePaginationParams({});
        expect(result.page).toBe(DEFAULT_PAGE);
        expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE);
        expect(result.offset).toBe(0);
      });

      it('returns default page=1 when only pageSize is provided', () => {
        const result = parsePaginationParams({ pageSize: '10' });
        expect(result.page).toBe(1);
        expect(result.pageSize).toBe(10);
        expect(result.offset).toBe(0);
      });

      it('returns default pageSize=20 when only page is provided', () => {
        const result = parsePaginationParams({ page: '3' });
        expect(result.page).toBe(3);
        expect(result.pageSize).toBe(20);
        expect(result.offset).toBe(40);
      });

      it('treats empty string as not provided', () => {
        const result = parsePaginationParams({ page: '', pageSize: '' });
        expect(result.page).toBe(DEFAULT_PAGE);
        expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE);
      });

      it('treats null as not provided', () => {
        const result = parsePaginationParams({ page: null, pageSize: null });
        expect(result.page).toBe(DEFAULT_PAGE);
        expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE);
      });

      it('treats undefined as not provided', () => {
        const result = parsePaginationParams({ page: undefined, pageSize: undefined });
        expect(result.page).toBe(DEFAULT_PAGE);
        expect(result.pageSize).toBe(DEFAULT_PAGE_SIZE);
      });
    });

    describe('valid inputs', () => {
      it('parses valid page and pageSize as strings', () => {
        const result = parsePaginationParams({ page: '2', pageSize: '50' });
        expect(result.page).toBe(2);
        expect(result.pageSize).toBe(50);
        expect(result.offset).toBe(50);
      });

      it('parses valid page and pageSize as numbers', () => {
        const result = parsePaginationParams({ page: 5, pageSize: 25 });
        expect(result.page).toBe(5);
        expect(result.pageSize).toBe(25);
        expect(result.offset).toBe(100);
      });

      it('computes correct offset for page 1', () => {
        const result = parsePaginationParams({ page: '1', pageSize: '10' });
        expect(result.offset).toBe(0);
      });

      it('computes correct offset for page 3 with pageSize 15', () => {
        const result = parsePaginationParams({ page: '3', pageSize: '15' });
        expect(result.offset).toBe(30);
      });

      it('accepts pageSize of exactly 100', () => {
        const result = parsePaginationParams({ pageSize: '100' });
        expect(result.pageSize).toBe(100);
      });

      it('accepts page of 1 (minimum valid)', () => {
        const result = parsePaginationParams({ page: '1' });
        expect(result.page).toBe(1);
      });
    });

    describe('pageSize capping', () => {
      it('caps pageSize at 100 when value exceeds maximum', () => {
        const result = parsePaginationParams({ pageSize: '200' });
        expect(result.pageSize).toBe(MAX_PAGE_SIZE);
      });

      it('caps pageSize at 100 for very large values', () => {
        const result = parsePaginationParams({ pageSize: '999999' });
        expect(result.pageSize).toBe(MAX_PAGE_SIZE);
      });

      it('caps pageSize at 100 when provided as number', () => {
        const result = parsePaginationParams({ pageSize: 150 });
        expect(result.pageSize).toBe(MAX_PAGE_SIZE);
      });

      it('does not error when capping pageSize', () => {
        expect(() => parsePaginationParams({ pageSize: '500' })).not.toThrow();
      });
    });

    describe('invalid inputs - rejection with 400', () => {
      it('rejects non-numeric page', () => {
        expect(() => parsePaginationParams({ page: 'abc' })).toThrow(ValidationError);
        try {
          parsePaginationParams({ page: 'abc' });
        } catch (e: any) {
          expect(e.statusCode).toBe(400);
          expect(e.details.field).toBe('page');
        }
      });

      it('rejects non-numeric pageSize', () => {
        expect(() => parsePaginationParams({ pageSize: 'xyz' })).toThrow(ValidationError);
        try {
          parsePaginationParams({ pageSize: 'xyz' });
        } catch (e: any) {
          expect(e.statusCode).toBe(400);
          expect(e.details.field).toBe('pageSize');
        }
      });

      it('rejects page less than 1', () => {
        expect(() => parsePaginationParams({ page: '0' })).toThrow(ValidationError);
        expect(() => parsePaginationParams({ page: '-1' })).toThrow(ValidationError);
      });

      it('rejects pageSize less than 1', () => {
        expect(() => parsePaginationParams({ pageSize: '0' })).toThrow(ValidationError);
        expect(() => parsePaginationParams({ pageSize: '-5' })).toThrow(ValidationError);
      });

      it('rejects non-integer page (decimal)', () => {
        expect(() => parsePaginationParams({ page: '1.5' })).toThrow(ValidationError);
        expect(() => parsePaginationParams({ page: '2.7' })).toThrow(ValidationError);
      });

      it('rejects non-integer pageSize (decimal)', () => {
        expect(() => parsePaginationParams({ pageSize: '10.5' })).toThrow(ValidationError);
      });

      it('rejects special string values', () => {
        expect(() => parsePaginationParams({ page: 'NaN' })).toThrow(ValidationError);
        expect(() => parsePaginationParams({ page: 'Infinity' })).toThrow(ValidationError);
        expect(() => parsePaginationParams({ page: '-Infinity' })).toThrow(ValidationError);
      });

      it('rejects boolean-like strings', () => {
        expect(() => parsePaginationParams({ page: 'true' })).toThrow(ValidationError);
        expect(() => parsePaginationParams({ page: 'false' })).toThrow(ValidationError);
      });

      it('rejects strings with mixed content', () => {
        expect(() => parsePaginationParams({ page: '1abc' })).toThrow(ValidationError);
        expect(() => parsePaginationParams({ pageSize: '50px' })).toThrow(ValidationError);
      });
    });
  });

  // ─── computePaginationMeta ───────────────────────────────────────────────

  describe('computePaginationMeta', () => {
    it('computes correct metadata for standard case', () => {
      const meta = computePaginationMeta(1, 20, 100);
      expect(meta).toEqual({
        page: 1,
        pageSize: 20,
        total: 100,
        totalPages: 5,
        hasNext: true,
        hasPrev: false,
      });
    });

    it('computes correct metadata for last page', () => {
      const meta = computePaginationMeta(5, 20, 100);
      expect(meta).toEqual({
        page: 5,
        pageSize: 20,
        total: 100,
        totalPages: 5,
        hasNext: false,
        hasPrev: true,
      });
    });

    it('computes correct metadata for middle page', () => {
      const meta = computePaginationMeta(3, 10, 50);
      expect(meta).toEqual({
        page: 3,
        pageSize: 10,
        total: 50,
        totalPages: 5,
        hasNext: true,
        hasPrev: true,
      });
    });

    it('handles single page of results', () => {
      const meta = computePaginationMeta(1, 20, 5);
      expect(meta).toEqual({
        page: 1,
        pageSize: 20,
        total: 5,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });
    });

    it('handles zero total records', () => {
      const meta = computePaginationMeta(1, 20, 0);
      expect(meta).toEqual({
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      });
    });

    it('handles page beyond totalPages (empty data scenario)', () => {
      const meta = computePaginationMeta(10, 20, 50);
      // totalPages = ceil(50/20) = 3, page 10 > 3 so hasNext = false
      expect(meta).toEqual({
        page: 10,
        pageSize: 20,
        total: 50,
        totalPages: 3,
        hasNext: false,
        hasPrev: true,
      });
    });

    it('computes totalPages with ceiling division', () => {
      // 51 items / 20 per page = 2.55 → ceil = 3
      const meta = computePaginationMeta(1, 20, 51);
      expect(meta.totalPages).toBe(3);
    });

    it('computes totalPages correctly when total is exact multiple of pageSize', () => {
      const meta = computePaginationMeta(1, 25, 100);
      expect(meta.totalPages).toBe(4);
    });

    it('hasPrev is false for page 1', () => {
      const meta = computePaginationMeta(1, 10, 100);
      expect(meta.hasPrev).toBe(false);
    });

    it('hasPrev is true for page > 1', () => {
      const meta = computePaginationMeta(2, 10, 100);
      expect(meta.hasPrev).toBe(true);
    });

    it('hasNext is true when page < totalPages', () => {
      const meta = computePaginationMeta(1, 10, 100);
      expect(meta.hasNext).toBe(true);
    });

    it('hasNext is false when page >= totalPages', () => {
      const meta = computePaginationMeta(10, 10, 100);
      expect(meta.hasNext).toBe(false);
    });

    it('handles total of 1 with pageSize 1', () => {
      const meta = computePaginationMeta(1, 1, 1);
      expect(meta).toEqual({
        page: 1,
        pageSize: 1,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });
    });
  });

  // ─── paginateQuery ───────────────────────────────────────────────────────

  describe('paginateQuery', () => {
    it('appends LIMIT and OFFSET to a basic query', () => {
      const result = paginateQuery('SELECT * FROM users', 1, 20);
      expect(result).toBe('SELECT * FROM users LIMIT 20 OFFSET 0');
    });

    it('computes correct offset for page 2', () => {
      const result = paginateQuery('SELECT * FROM items', 2, 10);
      expect(result).toBe('SELECT * FROM items LIMIT 10 OFFSET 10');
    });

    it('computes correct offset for page 5 with pageSize 25', () => {
      const result = paginateQuery('SELECT * FROM records WHERE active = true', 5, 25);
      expect(result).toBe('SELECT * FROM records WHERE active = true LIMIT 25 OFFSET 100');
    });

    it('handles page 1 with offset 0', () => {
      const result = paginateQuery('SELECT id, name FROM departments', 1, 50);
      expect(result).toBe('SELECT id, name FROM departments LIMIT 50 OFFSET 0');
    });

    it('preserves existing query with ORDER BY', () => {
      const result = paginateQuery('SELECT * FROM logs ORDER BY created_at DESC', 3, 15);
      expect(result).toBe('SELECT * FROM logs ORDER BY created_at DESC LIMIT 15 OFFSET 30');
    });
  });
});
