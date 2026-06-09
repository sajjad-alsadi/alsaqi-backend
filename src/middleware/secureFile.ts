import { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { SecureFileOptions } from '../types/middleware';
import db from '../db/index';
import logger from '../utils/logger';
import { SecureFileService } from '../services/SecureFileService';
import { FileEncryptionService } from '../services/FileEncryptionService';
import { ModuleRegistry } from '../permissions/registry';
import { PermissionService } from '../services/PermissionService';
import { UserRole } from '@alsaqi/shared';

/**
 * Logs a file access attempt to the file_access_logs table.
 * On failure, writes to stderr and continues without affecting the response.
 */
async function logFileAccess(
  userId: string,
  filePath: string,
  accessType: 'view' | 'download',
  result: 'granted' | 'denied',
  ipAddress: string
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO file_access_logs (user_id, file_path, access_type, result, ip_address)
       VALUES (?, ?, ?, ?, ?)`
    ).run(userId, filePath, accessType, result, ipAddress);
  } catch (err) {
    process.stderr.write(
      `[SecureFile] Failed to log file access: ${err instanceof Error ? err.message : String(err)}\n` +
      `  userId=${userId}, filePath=${filePath}, result=${result}\n`
    );
  }
}

/**
 * Checks if a user has module-level permission to access a file.
 * Reads the file's owning module from the encrypted_files table and validates:
 * 1. File has a module field (non-empty)
 * 2. Module is registered in ModuleRegistry
 * 3. Module has fileScope: true
 * 4. User has View permission for that module
 *
 * Admins always have access. Returns { allowed, module } for structured error responses.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */
async function checkFilePermission(
  userId: string,
  userRole: string,
  filePath: string
): Promise<{ allowed: boolean; module?: string; reason?: string }> {
  // Admins always have access
  if (userRole === UserRole.ADMIN) return { allowed: true };

  try {
    // Extract file ID from path to look up the file record's module
    const fileName = path.basename(filePath).replace(/\.enc$/, '');
    const fileRecord = await db.prepare(
      `SELECT module FROM encrypted_files WHERE id = ?`
    ).get(fileName) as { module: string } | undefined;

    // Req 10.3: Deny if file has no module field or module is empty
    const fileModule = fileRecord?.module;
    if (!fileModule || fileModule.trim() === '') {
      return { allowed: false, module: undefined, reason: 'File has no owning module' };
    }

    // Req 10.4: Deny if module is not registered in ModuleRegistry
    const moduleDef = ModuleRegistry.getModule(fileModule);
    if (!moduleDef) {
      return { allowed: false, module: fileModule, reason: `Module '${fileModule}' is not registered` };
    }

    // Req 10.6: Deny if module has fileScope: false (or undefined/not set)
    if (!moduleDef.fileScope) {
      return { allowed: false, module: fileModule, reason: `Module '${fileModule}' does not support file scoping` };
    }

    // Req 10.2: Check user's View permission for the file's owning module
    const allowed = await PermissionService.hasPermission(userId, fileModule, 'View');
    return { allowed, module: fileModule };
  } catch (err) {
    logger.error('Error checking file permission', { userId, filePath, error: err });
    return { allowed: false, reason: 'Permission check failed' };
  }
}

/**
 * Creates a secure file access middleware that replaces express.static for /uploads.
 *
 * Features:
 * - Requires valid authentication token (401 if missing/invalid)
 * - Checks module-level permission (403 if unauthorized)
 * - Logs every access attempt (granted/denied) to file_access_logs table
 * - Serves the file if authorized using res.sendFile
 * - Supports signed URLs (handled externally in task 13.2 - for now, just checks auth token)
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4
 */
export function createSecureFileMiddleware(
  authenticate: (req: any, res: any, next: any) => void,
  uploadDir: string,
  options: SecureFileOptions = {}
) {
  const {
    requireAuth = true,
    checkPermission = true,
    auditAccess = true,
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const filePath = req.path; // e.g., /filename.ext (relative to /uploads mount)
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    // Step 0: Check for signed URL (allows unauthenticated access with valid signature)
    const { expires, userId: sigUserId, sig } = req.query as {
      expires?: string;
      userId?: string;
      sig?: string;
    };

    if (expires && sigUserId && sig) {
      const expiresNum = parseInt(expires, 10);
      if (!isNaN(expiresNum)) {
        const result = SecureFileService.verifySignedUrl(filePath, sigUserId, expiresNum, sig);

        if (result.valid) {
          // Valid signed URL - log access and serve file without auth
          if (auditAccess) {
            logFileAccess(sigUserId, filePath, 'view', 'granted', ip);
          }
          serveFile(req, res, uploadDir, filePath);
          return;
        }

        // Expired signed URL - return 401 indicating expiration
        if (result.expired) {
          if (auditAccess) {
            logFileAccess(sigUserId || 'anonymous', filePath, 'view', 'denied', ip);
          }
          return res.status(401).json({ error: 'Signed URL has expired' });
        }

        // Invalid signature - fall through to normal auth flow
      }
    }

    // Step 1: Authenticate the user
    if (requireAuth) {
      // Override res.json to intercept auth failure responses and log them
      const originalJson = res.json.bind(res);
      let authIntercepted = false;

      res.json = ((data: any) => {
        // If authenticate sends a 401/403 before our callback runs, log the denial
        if (!authIntercepted && res.statusCode >= 400 && auditAccess) {
          authIntercepted = true;
          logFileAccess('anonymous', filePath, 'view', 'denied', ip);
        }
        return originalJson(data);
      }) as any;

      authenticate(req, res, async (authErr?: any) => {
        // Restore original json
        res.json = originalJson;
        authIntercepted = true;

        if (authErr) {
          // Authentication error passed to next - log and return 401
          if (auditAccess) {
            await logFileAccess('anonymous', filePath, 'view', 'denied', ip);
          }
          return res.status(401).json({ error: 'Unauthorized' });
        }

        // If authenticate called next() without setting req.user, auth failed silently
        if (!(req as any).user) {
          if (auditAccess) {
            await logFileAccess('anonymous', filePath, 'view', 'denied', ip);
          }
          return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = (req as any).user;

        // Step 2: Check module-level permission (file-level scoping)
        if (checkPermission) {
          const permResult = await checkFilePermission(user.id, user.role, filePath);
          if (!permResult.allowed) {
            if (auditAccess) {
              await logFileAccess(user.id, filePath, 'view', 'denied', ip);
            }
            return res.status(403).json({
              error: permResult.module
                ? `Forbidden: Missing permission 'View' on module '${permResult.module}'`
                : 'Forbidden: File has no valid owning module',
              code: 'PERMISSION_DENIED',
              module: permResult.module || null,
              action: 'View',
            });
          }
        }

        // Step 3: Log successful access
        if (auditAccess) {
          await logFileAccess(user.id, filePath, 'view', 'granted', ip);
        }

        // Step 4: Serve the file
        serveFile(req, res, uploadDir, filePath);
      });
    } else {
      // No auth required - just serve the file (for signed URL support in task 13.2)
      serveFile(req, res, uploadDir, filePath);
    }
  };
}

/**
 * Serves a file from the upload directory with security checks on the path.
 * If the file is encrypted (has a record in encrypted_files table or .enc extension),
 * it will be decrypted transparently before streaming to the client.
 */
async function serveFile(req: Request, res: Response, uploadDir: string, filePath: string): Promise<void> {
  // Prevent path traversal attacks
  const normalizedPath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(uploadDir, normalizedPath);

  // Ensure the resolved path is within the upload directory
  const resolvedUploadDir = path.resolve(uploadDir);
  const resolvedFilePath = path.resolve(fullPath);

  if (!resolvedFilePath.startsWith(resolvedUploadDir)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  // Extract the file identifier from the path (e.g., "abc123.enc" -> "abc123")
  const fileName = path.basename(normalizedPath);
  const fileId = fileName.replace(/\.enc$/, '');

  // Check if this file has encryption metadata in the database
  const encryptedRecord = await lookupEncryptedFile(fileId);

  if (encryptedRecord) {
    // File is encrypted — decrypt and stream to client
    await serveEncryptedFile(res, uploadDir, fileId, encryptedRecord);
    return;
  }

  // Not encrypted — check if file exists and serve normally (backward compatibility)
  if (!fs.existsSync(resolvedFilePath) || !fs.statSync(resolvedFilePath).isFile()) {
    // Also try without .enc extension in case the path already has it
    res.status(404).json({ error: 'File not found' });
    return;
  }

  // Send the file as-is (non-encrypted)
  res.sendFile(resolvedFilePath);
}

/**
 * Looks up encryption metadata for a file from the encrypted_files database table.
 * Returns null if the file is not encrypted (no record found).
 */
async function lookupEncryptedFile(fileId: string): Promise<EncryptedFileRecord | null> {
  try {
    const result = await db.prepare(`
      SELECT id, original_name, mime_type, original_size, encrypted_path,
             iv, auth_tag, checksum_sha256, key_version
      FROM encrypted_files
      WHERE id = ?
    `).get(fileId) as EncryptedFileRecord | undefined;

    return result || null;
  } catch (err) {
    logger.error('[SecureFile] Failed to lookup encrypted file metadata', { fileId, error: err });
    return null;
  }
}

/**
 * Decrypts an encrypted file and streams the plaintext to the client
 * with appropriate response headers (Content-Type, Content-Disposition, Content-Length).
 */
async function serveEncryptedFile(
  res: Response,
  uploadDir: string,
  fileId: string,
  record: EncryptedFileRecord
): Promise<void> {
  try {
    const encryptionService = new FileEncryptionService(uploadDir);

    // Load the metadata into the service so decryptFile can find it
    encryptionService.setMetadata(fileId, {
      fileId,
      originalName: record.original_name,
      mimeType: record.mime_type,
      size: record.original_size,
      iv: record.iv,
      authTag: record.auth_tag,
      encryptedAt: '',
      checksum: record.checksum_sha256,
      keyVersion: record.key_version,
    });

    const { buffer } = await encryptionService.decryptFile(fileId);

    // Set response headers for the decrypted file
    res.setHeader('Content-Type', record.mime_type);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(record.original_name)}"`
    );

    // Stream the decrypted content to the client
    res.send(buffer);
  } catch (err) {
    logger.error('[SecureFile] Failed to decrypt file', { fileId, error: err });
    res.status(500).json({ error: 'Failed to retrieve file' });
  }
}

/**
 * Database record shape for encrypted_files table lookups.
 */
interface EncryptedFileRecord {
  id: string;
  original_name: string;
  mime_type: string;
  original_size: number;
  encrypted_path: string;
  iv: string;
  auth_tag: string;
  checksum_sha256: string;
  key_version: number;
}
