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
import { checkContainment } from './pathContainment';

/**
 * Fixed placeholder identifier recorded for a denial when no authenticated user
 * (or known signer) is established for the request (Req 13.3).
 */
const ANONYMOUS_USER_ID = 'anonymous';

/**
 * The denial categories recorded for an authorization denial (Req 13.2).
 */
type DenialCategory =
  | 'authentication failure'
  | 'expired signed URL'
  | 'missing module permission'
  | 'no valid owning module';

/**
 * Logs a file access attempt to the file_access_logs table.
 *
 * For denials, `reason` carries the denial category (Req 13.2) so the entry is
 * categorized. On a write failure the function leaves the response untouched and
 * writes a notice to stderr (Req 13.4).
 */
async function logFileAccess(
  userId: string,
  filePath: string,
  accessType: 'view' | 'download',
  result: 'granted' | 'denied',
  ipAddress: string,
  reason?: DenialCategory
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO file_access_logs (user_id, file_path, access_type, result, ip_address)
       VALUES (?, ?, ?, ?, ?)`
    ).run(userId, filePath, accessType, result, ipAddress);
  } catch (err) {
    process.stderr.write(
      `[SecureFile] Failed to log file access: ${err instanceof Error ? err.message : String(err)}\n` +
      `  userId=${userId}, filePath=${filePath}, result=${result}` +
      `${reason ? `, reason=${reason}` : ''}\n`
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
 * Re-reads a signer's current standing from the authoritative users table.
 *
 * Returns the signer's current `role` and `status`, or `null` when no user
 * record exists. This is the live record consulted at serve time for signed-URL
 * re-authorization, so that suspending or removing a user revokes their
 * outstanding signed URLs promptly.
 *
 * Requirements: 11.1, 11.2
 */
async function getSignerStanding(
  signerId: string
): Promise<{ id: string; role: string; status: string } | null> {
  try {
    const signer = await db.prepare(
      `SELECT id, role, status FROM users WHERE id = ?`
    ).get(signerId) as { id: string; role: string; status: string } | undefined;
    return signer ?? null;
  } catch (err) {
    logger.error('[SecureFile] Failed to read signer standing', { signerId, error: err });
    return null;
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

    // Resilient denial logging (Req 13.1-13.4). Rather than wrapping res.json, a
    // single `finish` listener inspects the FINAL status code once the response has
    // completed and records exactly one categorized denial entry per denied request.
    // Denial branches below populate `denial` with the responsible user id and the
    // denial category before sending their error response; `accessGranted` is set on
    // any granted path so a later non-2xx from serving (e.g. 404/500) is not
    // mis-logged as an authorization denial and granted requests are never
    // double-logged.
    let accessGranted = false;
    const denial: { userId: string; reason: DenialCategory } = {
      userId: ANONYMOUS_USER_ID,
      reason: 'authentication failure',
    };

    if (auditAccess && typeof res.on === 'function') {
      res.on('finish', () => {
        if (accessGranted) return; // granted requests are logged exactly once inline
        if (res.statusCode >= 400) {
          // Exactly one denial entry, carrying the file identifier and category,
          // using the anonymous placeholder when no user/signer was established.
          void logFileAccess(denial.userId, filePath, 'view', 'denied', ip, denial.reason);
        }
      });
    }

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
          // Signature is cryptographically valid and unexpired, but a valid
          // signature alone is NOT sufficient. Before serving any content we
          // re-evaluate the signer's CURRENT standing against live records so
          // that suspending or de-permissioning the signer revokes access
          // immediately (Req 11.1).
          void (async () => {
            // Req 11.1, 11.2: deny if the signer is missing or not currently active
            // (inactive/suspended/disabled), even though the signature is valid.
            const signer = await getSignerStanding(sigUserId);
            if (!signer || signer.status !== 'Active') {
              // Unknown/inactive signer => the request is not authenticated as a
              // valid active user (Req 13.2 authentication-failure category). Record
              // the claimed signer id when present, otherwise the anonymous placeholder.
              denial.userId = sigUserId || ANONYMOUS_USER_ID;
              denial.reason = 'authentication failure';
              return res.status(403).json({ error: 'Access denied' });
            }

            // Req 11.1, 11.3: re-check the signer's CURRENT required permission for
            // the file's owning module; deny if the permission is missing at serve
            // time, even though the signature is valid.
            if (checkPermission) {
              const permResult = await checkFilePermission(signer.id, signer.role, filePath);
              if (!permResult.allowed) {
                denial.userId = signer.id;
                denial.reason = permResult.module
                  ? 'missing module permission'
                  : 'no valid owning module';
                return res.status(403).json({ error: 'Access denied' });
              }
            }

            // Signer is active and currently authorized - log access and serve.
            accessGranted = true;
            if (auditAccess) {
              await logFileAccess(signer.id, filePath, 'view', 'granted', ip);
            }
            await serveFile(req, res, uploadDir, filePath);
          })();
          return;
        }

        // Req 11.3: Expired signed URL - deny without serving any content.
        if (result.expired) {
          denial.userId = sigUserId || ANONYMOUS_USER_ID;
          denial.reason = 'expired signed URL';
          return res.status(401).json({ error: 'Signed URL has expired' });
        }

        // Invalid signature - fall through to normal auth flow
      }
    }

    // Step 1: Authenticate the user
    if (requireAuth) {
      authenticate(req, res, async (authErr?: any) => {
        if (authErr) {
          // Authentication error passed to next - the finish listener records the
          // denial once (Req 13.1, 13.2) with the anonymous placeholder (Req 13.3).
          denial.userId = ANONYMOUS_USER_ID;
          denial.reason = 'authentication failure';
          return res.status(401).json({ error: 'Unauthorized' });
        }

        // If authenticate called next() without setting req.user, auth failed silently
        if (!(req as any).user) {
          denial.userId = ANONYMOUS_USER_ID;
          denial.reason = 'authentication failure';
          return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = (req as any).user;

        // Step 2: Check module-level permission (file-level scoping)
        if (checkPermission) {
          const permResult = await checkFilePermission(user.id, user.role, filePath);
          if (!permResult.allowed) {
            denial.userId = user.id;
            denial.reason = permResult.module
              ? 'missing module permission'
              : 'no valid owning module';
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

        // Step 3: Log successful access (exactly once)
        accessGranted = true;
        if (auditAccess) {
          await logFileAccess(user.id, filePath, 'view', 'granted', ip);
        }

        // Step 4: Serve the file
        serveFile(req, res, uploadDir, filePath);
      });
    } else {
      // No auth required - serving is granted, so suppress denial logging for any
      // later non-2xx produced while serving (e.g. file not found).
      accessGranted = true;
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
  // Req 10.1, 10.2, 10.4: Confine reads to the upload directory using the canonical
  // containment check (resolves '.'/'..', dereferences symlinks, separator-aware
  // prefix match that rejects siblings such as `uploads_backup`).
  const containment = checkContainment(uploadDir, filePath);

  if (!containment.contained) {
    // Req 10.5: Record a server-side security event capturing the rejection. The
    // resolved path is logged server-side ONLY and is never returned to the caller.
    logger.warn('[SecureFile] Path containment denied', {
      requestedPath: filePath,
      resolvedPath: containment.resolvedPath,
      uploadDir,
      ip: req.ip || req.socket?.remoteAddress || 'unknown',
    });
    // Req 10.3: Opaque response that does not disclose the resolved path or whether
    // the target exists.
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const resolvedFilePath = containment.resolvedPath as string;

  // Extract the file identifier from the path (e.g., "abc123.enc" -> "abc123")
  const fileName = path.basename(resolvedFilePath);
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
 * Decrypts an encrypted file and streams the plaintext to the client in bounded
 * chunks (≤ 64 KB) with appropriate response headers (Content-Type,
 * Content-Disposition, Content-Length).
 *
 * The decrypted content is never fully buffered in memory: each chunk is piped to the
 * response as it is decrypted (Req 12.1, 12.2, 12.3). A chunk decryption or GCM
 * auth-tag failure terminates the response stream with a delivery-failed error
 * (Req 12.4). If the client disconnects before the transfer completes, the decrypt
 * stream and its underlying file handle are released (Req 12.5).
 */
async function serveEncryptedFile(
  res: Response,
  uploadDir: string,
  fileId: string,
  record: EncryptedFileRecord
): Promise<void> {
  let stream: NodeJS.ReadableStream;

  try {
    const encryptionService = new FileEncryptionService(uploadDir);

    // Load the metadata into the service so createDecryptStream can find it
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

    const result = await encryptionService.createDecryptStream(fileId);
    stream = result.stream;
  } catch (err) {
    // Failure before any byte is written (e.g. missing metadata/key, truncated header).
    logger.error('[SecureFile] Failed to start decryption stream', { fileId, error: err });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to retrieve file' });
    }
    return;
  }

  // Set response headers before streaming. The decrypted (plaintext) length equals the
  // recorded original size for AES-GCM (ciphertext length == plaintext length).
  res.setHeader('Content-Type', record.mime_type);
  res.setHeader('Content-Length', record.original_size);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(record.original_name)}"`
  );

  // Req 12.5: On client disconnect (before the response is fully flushed), stop reading
  // and decrypting and release the stream + file handle.
  const onClientClose = (): void => {
    if (!res.writableFinished) {
      stream.destroy();
    }
  };
  res.on('close', onClientClose);

  // Req 12.4: A chunk-decryption or GCM auth-tag failure surfaces here. Terminate the
  // response so the client never receives a complete/valid body for a tampered file.
  stream.on('error', (err: Error) => {
    logger.error('[SecureFile] Decryption stream failed during delivery', { fileId, error: err });
    res.removeListener('close', onClientClose);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to retrieve file' });
    } else {
      // Headers already sent — abruptly terminate the response to signal delivery failure.
      res.destroy(err);
    }
  });

  res.on('finish', () => {
    res.removeListener('close', onClientClose);
  });

  // Pipe decrypted chunks straight to the response, writing each before the next is
  // decrypted (bounded memory).
  stream.pipe(res);
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
