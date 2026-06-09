import fs from 'fs';
import path from 'path';
import { db } from '../db/index';
import { NumberingService } from './NumberingService';
import { NotFoundError, ValidationError } from '../utils/errors';

/**
 * EvidenceStorageService: Manages structured file storage for audit evidence.
 *
 * Evidence files are stored in organized directories following the pattern:
 *   /uploads/findings/{plan_id}/{finding_id}/{evidence_number}_{file_name}
 *
 * Provides:
 * - Path construction with sanitized file names
 * - File name sanitization (path traversal prevention)
 * - Atomic evidence attachment with rollback on failure
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */

export interface EvidenceFile {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
}

export interface EvidenceData {
  type: 'Document' | 'Email' | 'Screenshot' | 'System Log' | 'Contract';
  description: string;
}

export interface AttachEvidenceResult {
  id: string;
  evidence_number: string;
  file_path: string;
  finding_id: string;
}

export class EvidenceStorageService {
  /** Base directory for uploads (relative to process.cwd()) */
  private static readonly UPLOAD_BASE = path.join(process.cwd(), 'uploads', 'findings');

  /**
   * Sanitizes a file name by removing path separators, traversal sequences,
   * absolute path prefixes, and truncating to 255 characters.
   *
   * Prevents path traversal attacks by stripping:
   * - Forward slashes (/)
   * - Backslashes (\)
   * - Parent directory sequences (../ or ..\)
   * - Absolute path prefixes (e.g., C:\, D:\, /)
   *
   * @param fileName - The original file name to sanitize
   * @returns The sanitized file name, truncated to 255 chars max
   */
  static sanitizeFileName(fileName: string): string {
    if (!fileName) return '';

    let sanitized = fileName;

    // Remove ../ and ..\ sequences (repeated until none remain)
    while (sanitized.includes('../') || sanitized.includes('..\\')) {
      sanitized = sanitized.replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
    }

    // Remove absolute path prefixes (Windows drive letters like C:\, D:/)
    sanitized = sanitized.replace(/^[A-Za-z]:[/\\]/g, '');

    // Remove leading slash (Unix absolute path)
    sanitized = sanitized.replace(/^[/\\]+/, '');

    // Remove all remaining path separators
    sanitized = sanitized.replace(/[/\\]/g, '');

    // Truncate to 255 characters
    if (sanitized.length > 255) {
      sanitized = sanitized.substring(0, 255);
    }

    return sanitized;
  }

  /**
   * Builds the structured evidence file path.
   *
   * Format: /uploads/findings/{plan_id}/{finding_id}/{evidence_number}_{file_name}
   *
   * @param planId - The audit plan UUID
   * @param findingId - The finding UUID
   * @param evidenceNumber - The sequential evidence number (e.g., "IA-PL-25-001-F01-E01")
   * @param fileName - The original file name (will be sanitized)
   * @returns The full relative path for the evidence file
   */
  static buildEvidencePath(
    planId: string,
    findingId: string,
    evidenceNumber: string,
    fileName: string
  ): string {
    const sanitizedName = this.sanitizeFileName(fileName);
    return `/uploads/findings/${planId}/${findingId}/${evidenceNumber}_${sanitizedName}`;
  }

  /**
   * Attaches evidence to a finding with atomic file write + DB insert.
   *
   * Workflow:
   * 1. Validate finding exists (fetch finding + plan info)
   * 2. Generate evidence_number via NumberingService
   * 3. Build structured file path
   * 4. Write file to disk (if fails → no DB insert)
   * 5. Insert DB record (if fails → delete written file)
   *
   * @param findingId - The finding UUID to attach evidence to
   * @param file - The uploaded file (buffer + originalname)
   * @param data - Evidence metadata (type, description)
   * @param userId - The user performing the upload
   * @returns The created evidence record details
   * @throws NotFoundError if finding does not exist
   * @throws Error if file write or DB insert fails
   */
  static async attachEvidence(
    findingId: string,
    file: EvidenceFile,
    data: EvidenceData,
    userId: string
  ): Promise<AttachEvidenceResult> {
    // 1. Validate finding exists and get plan info
    const finding = await db.prepare(
      `SELECT af.id, af.audit_id, af.finding_number
       FROM audit_findings af
       WHERE af.id = ?`
    ).get(findingId) as { id: string; audit_id: string; finding_number: string } | undefined;

    if (!finding) {
      throw new NotFoundError('الملاحظة غير موجودة / Finding not found');
    }

    const planId = finding.audit_id;

    // 2. Generate evidence number via NumberingService
    const evidenceNumber = await NumberingService.nextEvidenceNumber(findingId, finding.finding_number);

    // 3. Build structured file path
    const filePath = this.buildEvidencePath(planId, findingId, evidenceNumber, file.originalname);

    // 4. Write file to disk
    const absolutePath = path.join(process.cwd(), filePath);
    const dir = path.dirname(absolutePath);

    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(absolutePath, file.buffer, { mode: 0o600 });
    } catch (fileError) {
      // File write failed → no DB insert (Requirement 8.6)
      throw new Error(`فشل كتابة الملف / File storage failed: ${(fileError as Error).message}`);
    }

    // 5. Insert DB record - if fails, rollback file write (Requirement 8.7)
    try {
      const record = await db.prepare(`
        INSERT INTO audit_evidence (
          audit_id, finding_id, evidence_number, type, description,
          uploaded_by, upload_date, file_name, file_path
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
        RETURNING id, evidence_number, file_path, finding_id
      `).get(
        planId,
        findingId,
        evidenceNumber,
        data.type,
        data.description,
        userId,
        file.originalname,
        filePath
      ) as AttachEvidenceResult | undefined;

      if (!record) {
        throw new Error('Failed to insert evidence record');
      }

      return record;
    } catch (dbError) {
      // DB insert failed → rollback file write (delete the written file)
      try {
        await fs.promises.unlink(absolutePath);
      } catch {
        // Best effort cleanup - file may not exist if write was partial
      }
      throw new Error(`فشل حفظ سجل الدليل / Evidence record save failed: ${(dbError as Error).message}`);
    }
  }
}
