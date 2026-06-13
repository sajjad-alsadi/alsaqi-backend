/**
 * Pure path-containment helper for secure file serving.
 *
 * This helper backs the path-containment check in `Secure_File_Middleware`. It
 * confines file reads to the configured upload directory so that a crafted path
 * cannot traverse to sibling directories or escape the upload root.
 *
 * Addresses Requirement 10 (Secure File Path Containment):
 *  - Resolve the requested path to a canonical absolute path with all `.`/`..`
 *    segments collapsed and all symbolic links dereferenced before any file
 *    access occurs (Req 10.1).
 *  - Confirm the resolved path begins with the resolved upload directory path
 *    followed immediately by the platform path separator, treating a match of the
 *    directory name without a trailing separator (e.g. a sibling such as
 *    `uploads_backup`) as NOT contained (Req 10.2).
 *  - Reject parent-directory traversal whose resolution lands outside the resolved
 *    upload directory (Req 10.4).
 */

import path from 'path';
import fs from 'fs';

/**
 * Result of a containment check.
 *
 * - `contained` is true only when the resolved request path is inside (or equal
 *   to) the resolved upload directory at a path-separator boundary.
 * - `resolvedPath` is the canonical absolute path that was evaluated, or `null`
 *   when the path could not be resolved (in which case `contained` is false).
 */
export interface ContainmentResult {
  contained: boolean;
  resolvedPath: string | null;
}

/**
 * Dereference symbolic links along an absolute path, tolerating paths whose
 * leaf (or trailing segments) do not yet exist.
 *
 * `fs.realpathSync` throws when the target does not exist. Because a file being
 * served may legitimately not exist (and because the containment decision must
 * be made on the canonical location regardless of existence), this walks upward
 * to the nearest existing ancestor, dereferences that, and re-appends the
 * remaining non-existent segments. The remaining segments contain no `.`/`..`
 * because the caller resolves the path first.
 */
function realpathBestEffort(absolutePath: string): string {
  const trailing: string[] = [];
  let current = absolutePath;

  // Walk up until we find an existing ancestor we can dereference.
  // The loop terminates at the filesystem root, where `path.dirname` is idempotent.
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      // Re-attach any segments that did not exist on disk, in original order.
      return trailing.length > 0
        ? path.join(real, ...trailing.reverse())
        : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the root and still could not resolve; return the resolved
        // (but non-dereferenced) path so the caller can still range-check it.
        return absolutePath;
      }
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Determine whether a requested path resolves to a location contained within the
 * upload directory (Req 10.1, 10.2, 10.4).
 *
 * The check is separator-aware: the resolved path must either equal the resolved
 * upload directory exactly or begin with the upload directory followed by the
 * platform path separator. This correctly rejects sibling directories whose names
 * merely share the upload directory as a prefix (for example `uploads_backup`
 * against `uploads`).
 *
 * Symbolic links are dereferenced on both the upload directory and the requested
 * path before comparison, so a symlink inside the upload directory that points
 * outside of it is treated as not contained.
 *
 * The function never throws; on any unexpected failure it returns a non-contained
 * result with a `null` resolved path.
 *
 * @param uploadDir         The configured upload directory (absolute or relative).
 * @param requestedRelPath  The requested path, typically relative to the upload mount.
 */
export function checkContainment(
  uploadDir: string,
  requestedRelPath: string,
): ContainmentResult {
  try {
    // Canonicalize the upload directory: resolve to absolute, then dereference
    // symlinks so the comparison base is the real on-disk location.
    const resolvedBase = realpathBestEffort(path.resolve(uploadDir));

    // Resolve the requested path against the base. `path.resolve` collapses
    // `.`/`..` segments (Req 10.1); joining via resolve keeps an absolute request
    // path absolute while treating a relative one as upload-dir-relative.
    const candidate = path.resolve(resolvedBase, requestedRelPath);

    // Dereference symlinks on the candidate so a link that escapes the upload
    // directory is detected (Req 10.1).
    const resolvedPath = realpathBestEffort(candidate);

    // Separator-aware containment: exact match OR a true child at a separator
    // boundary. This rejects siblings like `uploads_backup` (Req 10.2, 10.4).
    const contained =
      resolvedPath === resolvedBase ||
      resolvedPath.startsWith(resolvedBase + path.sep);

    return { contained, resolvedPath };
  } catch {
    // Fail closed: any resolution error is treated as not contained.
    return { contained: false, resolvedPath: null };
  }
}
