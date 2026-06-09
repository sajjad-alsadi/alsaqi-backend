/**
 * File-level permission scoping middleware.
 *
 * Reads the `module` field from a file record and checks the user's
 * View permission for that specific module. This ensures files are
 * only accessible to users who have permission on the owning module.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

import { Request, Response, NextFunction } from 'express';
import { ModuleRegistry } from '../permissions/registry';
import { PermissionService } from '../services/PermissionService';
import { UserRole } from '@alsaqi/shared';
import db from '../db/index';

/**
 * Looks up a file record from the database by file ID.
 * Returns the file record including its `module` field.
 */
async function getFileRecord(fileId: string): Promise<{ id: string; module: string | null } | null> {
  try {
    const result = await db.prepare(
      'SELECT id, module FROM files WHERE id = ?'
    ).get(fileId);
    return (result as { id: string; module: string | null } | undefined) || null;
  } catch {
    return null;
  }
}

/**
 * Middleware that enforces file-level permission scoping.
 *
 * Flow:
 * 1. Admin bypass: Admin users always get access (Req 3.2)
 * 2. Read file's `module` field from the file record (Req 10.1)
 * 3. Deny if module is missing or empty (Req 10.3)
 * 4. Deny if module is not registered in ModuleRegistry (Req 10.4)
 * 5. Deny if module has fileScope=false (Req 10.6)
 * 6. Check user's View permission for the module (Req 10.2)
 * 7. Deny with 403 PERMISSION_DENIED if user lacks permission
 */
export async function checkFilePermission(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = (req as any).user;

  // Req 3.2: Admin bypass - Admin always has full access
  if (user && user.role === UserRole.ADMIN) {
    return next();
  }

  // Get file ID from request params
  const fileId = (req as any).params?.id;
  if (!fileId) {
    res.status(403).json({
      error: 'Access denied: file identifier missing',
      code: 'PERMISSION_DENIED',
    });
    return;
  }

  // Req 10.1: Read the module field from the file record
  const fileRecord = await getFileRecord(fileId);
  if (!fileRecord) {
    res.status(403).json({
      error: 'Access denied: file not found',
      code: 'PERMISSION_DENIED',
    });
    return;
  }

  const fileModule = fileRecord.module;

  // Req 10.3: Deny if file has no module field or it's empty
  if (!fileModule || fileModule.trim() === '') {
    res.status(403).json({
      error: 'Access denied: file has no associated module',
      code: 'PERMISSION_DENIED',
    });
    return;
  }

  // Req 10.4: Deny if module is not registered in ModuleRegistry
  const moduleDef = ModuleRegistry.getModule(fileModule);
  if (!moduleDef) {
    res.status(403).json({
      error: `Access denied: module '${fileModule}' is not registered`,
      code: 'PERMISSION_DENIED',
    });
    return;
  }

  // Req 10.6: Deny if module has fileScope=false
  if (moduleDef.fileScope === false) {
    res.status(403).json({
      error: `Access denied: module '${fileModule}' does not support file-level scoping`,
      code: 'PERMISSION_DENIED',
    });
    return;
  }

  // Req 10.2: Check user's View permission for the owning module
  const allowed = await PermissionService.hasPermission(user.id, fileModule, 'View');
  if (!allowed) {
    res.status(403).json({
      error: `Forbidden: Missing permission 'View' on module '${fileModule}'`,
      code: 'PERMISSION_DENIED',
      module: fileModule,
      action: 'View',
    });
    return;
  }

  // Permission granted - proceed
  next();
}
