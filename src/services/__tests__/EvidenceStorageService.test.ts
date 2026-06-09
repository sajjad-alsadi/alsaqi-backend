// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock the db module
vi.mock('../../db/index', () => {
  const mockPrepare = vi.fn();
  return {
    db: {
      prepare: mockPrepare,
    },
  };
});

// Mock NumberingService
vi.mock('../NumberingService', () => ({
  NumberingService: {
    nextEvidenceNumber: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', () => {
  const mockPromises = {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  };
  return {
    default: { promises: mockPromises },
    promises: mockPromises,
  };
});

import { EvidenceStorageService } from '../EvidenceStorageService';
import { db } from '../../db/index';
import { NumberingService } from '../NumberingService';
import fs from 'fs';
import { NotFoundError } from '../../utils/errors';

describe('EvidenceStorageService', () => {
  const mockDb = db as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sanitizeFileName', () => {
    it('should return empty string for empty input', () => {
      expect(EvidenceStorageService.sanitizeFileName('')).toBe('');
    });

    it('should return empty string for null/undefined input', () => {
      expect(EvidenceStorageService.sanitizeFileName(null as any)).toBe('');
      expect(EvidenceStorageService.sanitizeFileName(undefined as any)).toBe('');
    });

    it('should pass through a normal file name unchanged', () => {
      expect(EvidenceStorageService.sanitizeFileName('report.pdf')).toBe('report.pdf');
    });

    it('should remove forward slashes', () => {
      expect(EvidenceStorageService.sanitizeFileName('path/to/file.pdf')).toBe('pathtofile.pdf');
    });

    it('should remove backslashes', () => {
      expect(EvidenceStorageService.sanitizeFileName('path\\to\\file.pdf')).toBe('pathtofile.pdf');
    });

    it('should remove ../ sequences', () => {
      expect(EvidenceStorageService.sanitizeFileName('../../../etc/passwd')).toBe('etcpasswd');
    });

    it('should remove ..\\ sequences', () => {
      expect(EvidenceStorageService.sanitizeFileName('..\\..\\windows\\system32')).toBe('windowssystem32');
    });

    it('should remove Windows absolute path prefixes (C:\\)', () => {
      expect(EvidenceStorageService.sanitizeFileName('C:\\Users\\file.pdf')).toBe('Usersfile.pdf');
    });

    it('should remove Windows absolute path prefixes (D:/)', () => {
      expect(EvidenceStorageService.sanitizeFileName('D:/data/file.pdf')).toBe('datafile.pdf');
    });

    it('should remove Unix absolute path prefix (/)', () => {
      expect(EvidenceStorageService.sanitizeFileName('/etc/passwd')).toBe('etcpasswd');
    });

    it('should remove multiple leading slashes', () => {
      expect(EvidenceStorageService.sanitizeFileName('///file.pdf')).toBe('file.pdf');
    });

    it('should truncate to 255 characters', () => {
      const longName = 'a'.repeat(300) + '.pdf';
      const result = EvidenceStorageService.sanitizeFileName(longName);
      expect(result.length).toBe(255);
    });

    it('should handle combined attack vectors', () => {
      const malicious = 'C:\\..\\..\\../uploads/../../../etc/passwd';
      const result = EvidenceStorageService.sanitizeFileName(malicious);
      expect(result).not.toContain('/');
      expect(result).not.toContain('\\');
      expect(result).not.toContain('..');
    });

    it('should preserve file extension after sanitization', () => {
      expect(EvidenceStorageService.sanitizeFileName('my-file.pdf')).toBe('my-file.pdf');
      expect(EvidenceStorageService.sanitizeFileName('report_2025.docx')).toBe('report_2025.docx');
    });

    it('should handle file names with spaces', () => {
      expect(EvidenceStorageService.sanitizeFileName('my file name.pdf')).toBe('my file name.pdf');
    });

    it('should handle file names with dots (not traversal)', () => {
      expect(EvidenceStorageService.sanitizeFileName('file.v2.backup.pdf')).toBe('file.v2.backup.pdf');
    });
  });

  describe('buildEvidencePath', () => {
    it('should build correct path with all components', () => {
      const result = EvidenceStorageService.buildEvidencePath(
        'plan-uuid-001',
        'finding-uuid-001',
        'IA-PL-25-001-F01-E01',
        'report.pdf'
      );
      expect(result).toBe('/uploads/findings/plan-uuid-001/finding-uuid-001/IA-PL-25-001-F01-E01_report.pdf');
    });

    it('should sanitize the file name in the path', () => {
      const result = EvidenceStorageService.buildEvidencePath(
        'plan-uuid-001',
        'finding-uuid-001',
        'IA-PL-25-001-F01-E01',
        '../../../etc/passwd'
      );
      expect(result).toBe('/uploads/findings/plan-uuid-001/finding-uuid-001/IA-PL-25-001-F01-E01_etcpasswd');
      expect(result).not.toContain('..');
    });

    it('should handle file names with special characters', () => {
      const result = EvidenceStorageService.buildEvidencePath(
        'plan-001',
        'finding-001',
        'E01',
        'تقرير المراجعة.pdf'
      );
      expect(result).toBe('/uploads/findings/plan-001/finding-001/E01_تقرير المراجعة.pdf');
    });
  });

  describe('attachEvidence', () => {
    const findingId = 'finding-uuid-001';
    const userId = 'user-uuid-001';
    const file = {
      originalname: 'evidence-doc.pdf',
      buffer: Buffer.from('file content'),
      mimetype: 'application/pdf',
    };
    const data = {
      type: 'Document' as const,
      description: 'Audit evidence document',
    };

    it('should throw NotFoundError when finding does not exist', async () => {
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        EvidenceStorageService.attachEvidence(findingId, file, data, userId)
      ).rejects.toThrow(NotFoundError);
    });

    it('should successfully attach evidence when finding exists', async () => {
      // Finding exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: findingId,
          audit_id: 'plan-uuid-001',
          finding_number: 'IA-PL-25-001-F01',
        }),
      });

      // NumberingService returns evidence number
      vi.mocked(NumberingService.nextEvidenceNumber).mockResolvedValue('IA-PL-25-001-F01-E01');

      // fs.promises.mkdir succeeds
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined as any);

      // fs.promises.writeFile succeeds
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      // DB insert succeeds
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 'evidence-uuid-001',
          evidence_number: 'IA-PL-25-001-F01-E01',
          file_path: '/uploads/findings/plan-uuid-001/finding-uuid-001/IA-PL-25-001-F01-E01_evidence-doc.pdf',
          finding_id: findingId,
        }),
      });

      const result = await EvidenceStorageService.attachEvidence(findingId, file, data, userId);

      expect(result.id).toBe('evidence-uuid-001');
      expect(result.evidence_number).toBe('IA-PL-25-001-F01-E01');
      expect(result.file_path).toContain('/uploads/findings/plan-uuid-001/finding-uuid-001/');
      expect(result.finding_id).toBe(findingId);

      // Verify NumberingService was called correctly
      expect(NumberingService.nextEvidenceNumber).toHaveBeenCalledWith(findingId, 'IA-PL-25-001-F01');

      // Verify file was written
      expect(fs.promises.mkdir).toHaveBeenCalled();
      expect(fs.promises.writeFile).toHaveBeenCalled();
    });

    it('should not insert DB record when file write fails (Requirement 8.6)', async () => {
      // Finding exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: findingId,
          audit_id: 'plan-uuid-001',
          finding_number: 'IA-PL-25-001-F01',
        }),
      });

      // NumberingService returns evidence number
      vi.mocked(NumberingService.nextEvidenceNumber).mockResolvedValue('IA-PL-25-001-F01-E01');

      // fs.promises.mkdir succeeds
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined as any);

      // fs.promises.writeFile FAILS
      vi.mocked(fs.promises.writeFile).mockRejectedValue(new Error('Disk full'));

      await expect(
        EvidenceStorageService.attachEvidence(findingId, file, data, userId)
      ).rejects.toThrow(/File storage failed/);

      // DB insert should NOT have been called (only 1 prepare call for finding lookup)
      expect(mockDb.prepare).toHaveBeenCalledTimes(1);
    });

    it('should delete written file when DB insert fails (Requirement 8.7)', async () => {
      // Finding exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: findingId,
          audit_id: 'plan-uuid-001',
          finding_number: 'IA-PL-25-001-F01',
        }),
      });

      // NumberingService returns evidence number
      vi.mocked(NumberingService.nextEvidenceNumber).mockResolvedValue('IA-PL-25-001-F01-E01');

      // fs.promises.mkdir succeeds
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined as any);

      // fs.promises.writeFile succeeds
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      // DB insert FAILS
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockRejectedValue(new Error('DB constraint violation')),
      });

      // fs.promises.unlink for rollback
      vi.mocked(fs.promises.unlink).mockResolvedValue(undefined);

      await expect(
        EvidenceStorageService.attachEvidence(findingId, file, data, userId)
      ).rejects.toThrow(/Evidence record save failed/);

      // Verify file was deleted (rollback)
      expect(fs.promises.unlink).toHaveBeenCalled();
    });

    it('should handle rollback file deletion failure gracefully', async () => {
      // Finding exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: findingId,
          audit_id: 'plan-uuid-001',
          finding_number: 'IA-PL-25-001-F01',
        }),
      });

      // NumberingService returns evidence number
      vi.mocked(NumberingService.nextEvidenceNumber).mockResolvedValue('IA-PL-25-001-F01-E01');

      // fs.promises.mkdir succeeds
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined as any);

      // fs.promises.writeFile succeeds
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      // DB insert FAILS
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      // fs.promises.unlink ALSO fails (file cleanup fails)
      vi.mocked(fs.promises.unlink).mockRejectedValue(new Error('Permission denied'));

      // Should still throw the DB error, not the unlink error
      await expect(
        EvidenceStorageService.attachEvidence(findingId, file, data, userId)
      ).rejects.toThrow(/Evidence record save failed/);
    });

    it('should sanitize file name in the stored path', async () => {
      const maliciousFile = {
        originalname: '../../../etc/passwd',
        buffer: Buffer.from('content'),
        mimetype: 'text/plain',
      };

      // Finding exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: findingId,
          audit_id: 'plan-uuid-001',
          finding_number: 'IA-PL-25-001-F01',
        }),
      });

      // NumberingService returns evidence number
      vi.mocked(NumberingService.nextEvidenceNumber).mockResolvedValue('IA-PL-25-001-F01-E01');

      // fs operations succeed
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined as any);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      // DB insert succeeds
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 'evidence-uuid-002',
          evidence_number: 'IA-PL-25-001-F01-E01',
          file_path: '/uploads/findings/plan-uuid-001/finding-uuid-001/IA-PL-25-001-F01-E01_etcpasswd',
          finding_id: findingId,
        }),
      });

      const result = await EvidenceStorageService.attachEvidence(findingId, maliciousFile, data, userId);

      // The path should not contain traversal sequences
      expect(result.file_path).not.toContain('..');
      expect(result.file_path).not.toContain('etc/passwd');
    });

    it('should create directory structure before writing file', async () => {
      // Finding exists
      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: findingId,
          audit_id: 'plan-uuid-001',
          finding_number: 'IA-PL-25-001-F01',
        }),
      });

      vi.mocked(NumberingService.nextEvidenceNumber).mockResolvedValue('IA-PL-25-001-F01-E01');
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined as any);
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

      mockDb.prepare.mockReturnValueOnce({
        get: vi.fn().mockResolvedValue({
          id: 'evidence-uuid-003',
          evidence_number: 'IA-PL-25-001-F01-E01',
          file_path: '/uploads/findings/plan-uuid-001/finding-uuid-001/IA-PL-25-001-F01-E01_evidence-doc.pdf',
          finding_id: findingId,
        }),
      });

      await EvidenceStorageService.attachEvidence(findingId, file, data, userId);

      // Verify mkdir was called with recursive: true
      expect(fs.promises.mkdir).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
    });
  });
});
