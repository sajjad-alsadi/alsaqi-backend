// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  correspondenceAttachmentSchema,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_FILENAME_LENGTH,
} from './correspondence';
import { dashboardStatsQuerySchema, myTasksQuerySchema } from './dashboard';
import {
  analyticsBaseQuerySchema,
  findingsByRiskQuerySchema,
  findingsByStatusQuerySchema,
  recommendationsByStatusQuerySchema,
} from './analytics';
import {
  crudPaginationSchema,
  crudFilterValueSchema,
  crudQuerySchema,
  idParamSchema,
} from './crudFilters';

describe('Correspondence Attachment Schema', () => {
  const validAttachment = {
    correspondence_id: '550e8400-e29b-41d4-a716-446655440000',
    correspondence_type: 'incoming' as const,
    file_name: 'report.pdf',
    file_size: 1024,
    mime_type: 'application/pdf' as const,
  };

  it('accepts valid attachment data', () => {
    const result = correspondenceAttachmentSchema.safeParse(validAttachment);
    expect(result.success).toBe(true);
  });

  it('accepts valid attachment with optional description', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      description: 'Quarterly audit report',
    });
    expect(result.success).toBe(true);
  });

  it('rejects file size exceeding 10 MB', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      file_size: MAX_FILE_SIZE + 1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts file size exactly at 10 MB limit', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      file_size: MAX_FILE_SIZE,
    });
    expect(result.success).toBe(true);
  });

  it('rejects zero file size', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      file_size: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative file size', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      file_size: -100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects filename exceeding 255 characters', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      file_name: 'a'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('accepts filename at exactly 255 characters', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      file_name: 'a'.repeat(254) + '.pdf'.slice(0, 1), // 255 chars
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty filename', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      file_name: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects disallowed MIME type', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      mime_type: 'application/javascript',
    });
    expect(result.success).toBe(false);
  });

  it('rejects executable MIME type', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      mime_type: 'application/x-executable',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all allowed MIME types', () => {
    for (const mimeType of ALLOWED_MIME_TYPES) {
      const result = correspondenceAttachmentSchema.safeParse({
        ...validAttachment,
        mime_type: mimeType,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid correspondence_id (not UUID)', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      correspondence_id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid correspondence_type', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      correspondence_type: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer file size', () => {
    const result = correspondenceAttachmentSchema.safeParse({
      ...validAttachment,
      file_size: 1024.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('Dashboard Stats Query Schema', () => {
  it('accepts empty query (all optional)', () => {
    const result = dashboardStatsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts valid department filter', () => {
    const result = dashboardStatsQuerySchema.safeParse({ department: 'IT' });
    expect(result.success).toBe(true);
  });

  it('accepts valid riskLevel filter', () => {
    const result = dashboardStatsQuerySchema.safeParse({ riskLevel: 'high' });
    expect(result.success).toBe(true);
  });

  it('accepts both department and riskLevel', () => {
    const result = dashboardStatsQuerySchema.safeParse({
      department: 'Finance',
      riskLevel: 'critical',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid riskLevel value', () => {
    const result = dashboardStatsQuerySchema.safeParse({ riskLevel: 'extreme' });
    expect(result.success).toBe(false);
  });

  it('rejects department exceeding max length', () => {
    const result = dashboardStatsQuerySchema.safeParse({
      department: 'a'.repeat(256),
    });
    expect(result.success).toBe(false);
  });
});

describe('My Tasks Query Schema', () => {
  it('applies defaults when empty', () => {
    const result = myTasksQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(20);
    }
  });

  it('coerces string values to numbers', () => {
    const result = myTasksQuerySchema.safeParse({ page: '2', pageSize: '15' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.pageSize).toBe(15);
    }
  });

  it('rejects pageSize exceeding 100', () => {
    const result = myTasksQuerySchema.safeParse({ pageSize: '200' });
    expect(result.success).toBe(false);
  });

  it('rejects page less than 1', () => {
    const result = myTasksQuerySchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects pageSize less than 1', () => {
    const result = myTasksQuerySchema.safeParse({ pageSize: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric page', () => {
    const result = myTasksQuerySchema.safeParse({ page: 'abc' });
    expect(result.success).toBe(false);
  });
});

describe('Analytics Query Schemas', () => {
  it('accepts empty query for all analytics schemas', () => {
    expect(findingsByRiskQuerySchema.safeParse({}).success).toBe(true);
    expect(findingsByStatusQuerySchema.safeParse({}).success).toBe(true);
    expect(recommendationsByStatusQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts valid date range', () => {
    const query = { startDate: '2024-01-01', endDate: '2024-12-31' };
    const result = analyticsBaseQuerySchema.safeParse(query);
    expect(result.success).toBe(true);
  });

  it('accepts query with department filter', () => {
    const result = analyticsBaseQuerySchema.safeParse({ department: 'Audit' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid date format (DD/MM/YYYY)', () => {
    const result = analyticsBaseQuerySchema.safeParse({ startDate: '01/01/2024' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid date format (no dashes)', () => {
    const result = analyticsBaseQuerySchema.safeParse({ startDate: '20240101' });
    expect(result.success).toBe(false);
  });

  it('rejects department exceeding max length', () => {
    const result = analyticsBaseQuerySchema.safeParse({
      department: 'a'.repeat(256),
    });
    expect(result.success).toBe(false);
  });
});

describe('CRUD Pagination Schema', () => {
  it('applies defaults when empty', () => {
    const result = crudPaginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(50);
    }
  });

  it('coerces string values to numbers', () => {
    const result = crudPaginationSchema.safeParse({ page: '3', pageSize: '25' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.pageSize).toBe(25);
    }
  });

  it('rejects page less than 1', () => {
    const result = crudPaginationSchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects pageSize exceeding 200', () => {
    const result = crudPaginationSchema.safeParse({ pageSize: '201' });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric page', () => {
    const result = crudPaginationSchema.safeParse({ page: 'abc' });
    expect(result.success).toBe(false);
  });
});

describe('CRUD Filter Value Schema', () => {
  it('accepts normal filter values', () => {
    expect(crudFilterValueSchema.safeParse('Open').success).toBe(true);
    expect(crudFilterValueSchema.safeParse('In Progress').success).toBe(true);
    expect(crudFilterValueSchema.safeParse('2024-01-01').success).toBe(true);
  });

  it('rejects values containing semicolons (SQL injection attempt)', () => {
    const result = crudFilterValueSchema.safeParse('value; DROP TABLE users');
    expect(result.success).toBe(false);
  });

  it('rejects values containing SQL comment markers', () => {
    const result = crudFilterValueSchema.safeParse('value -- comment');
    expect(result.success).toBe(false);
  });

  it('rejects values exceeding 500 characters', () => {
    const result = crudFilterValueSchema.safeParse('a'.repeat(501));
    expect(result.success).toBe(false);
  });

  it('accepts values at exactly 500 characters', () => {
    const result = crudFilterValueSchema.safeParse('a'.repeat(500));
    expect(result.success).toBe(true);
  });
});

describe('CRUD Query Schema (pagination + filters)', () => {
  it('accepts pagination with additional filter fields', () => {
    const result = crudQuerySchema.safeParse({
      page: '1',
      pageSize: '20',
      status: 'Open',
      department: 'IT',
    });
    expect(result.success).toBe(true);
  });

  it('rejects filter values with SQL injection patterns', () => {
    const result = crudQuerySchema.safeParse({
      page: '1',
      pageSize: '20',
      status: "Open'; DROP TABLE--",
    });
    expect(result.success).toBe(false);
  });
});

describe('ID Param Schema', () => {
  it('accepts valid integer ID', () => {
    expect(idParamSchema.safeParse({ id: '123' }).success).toBe(true);
    expect(idParamSchema.safeParse({ id: '1' }).success).toBe(true);
  });

  it('accepts valid UUID', () => {
    expect(
      idParamSchema.safeParse({ id: '550e8400-e29b-41d4-a716-446655440000' }).success
    ).toBe(true);
  });

  it('rejects non-integer non-UUID strings', () => {
    expect(idParamSchema.safeParse({ id: 'abc' }).success).toBe(false);
    expect(idParamSchema.safeParse({ id: '12.5' }).success).toBe(false);
    expect(idParamSchema.safeParse({ id: '' }).success).toBe(false);
  });

  it('rejects malformed UUID', () => {
    expect(idParamSchema.safeParse({ id: '550e8400-e29b-41d4-a716' }).success).toBe(false);
  });
});
