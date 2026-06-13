/**
 * Pure path-gate helpers for path-safe authentication gating.
 *
 * These helpers back the password-change gate in `Auth_Middleware`. They operate
 * exclusively on `req.path` (never `req.originalUrl` or any query-string component)
 * so that a crafted query string cannot be used to bypass the gate.
 *
 * Addresses Requirement 3 (Path-Safe Authentication Gating):
 *  - `canonicalizePath` — percent-decode, resolve `.`/`..` segments, and strip a
 *    single trailing slash (Req 3.3).
 *  - `isPathAllowed` — exact match OR path-segment-boundary prefix match only,
 *    never substring matching (Req 3.1, 3.2, 3.4).
 */

/**
 * Fully percent-decode a raw path, tolerating malformed escape sequences.
 *
 * `decodeURIComponent` throws on malformed input (e.g. a lone `%`). Because the
 * gate must never crash on attacker-controlled input, an undecodable path is
 * returned unchanged so the downstream matcher can safely reject it.
 *
 * Decoding is applied repeatedly until the value stabilizes. A single decode
 * pass is *not* sufficient: a double-encoded sequence such as `%252e` decodes to
 * the literal `%2e` on the first pass and only becomes `.` on a second pass.
 * Decoding to a fixed point ensures that
 *  - canonicalization is idempotent (Req 3.3) — a once-canonicalized path has no
 *    remaining decodable escapes, so re-canonicalizing is a no-op, and
 *  - obfuscated traversal cannot survive a single pass to slip past the gate;
 *    double- (or N-times-) encoded `.`/`..` segments are resolved away too.
 *
 * Decoding strictly shrinks (or preserves) the string, so the loop always
 * terminates; a bound is kept as defense-in-depth against pathological input.
 */
function safeDecode(rawPath: string): string {
  let current = rawPath;
  // Each successful decode either shortens the string or leaves it unchanged,
  // so this converges quickly; the bound guards against any edge case.
  for (let i = 0; i < 16; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // Malformed escape sequence: stop and return the last good value so the
      // matcher can safely reject it without throwing.
      return current;
    }
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

/**
 * Produce a canonical path from a raw request path (Req 3.3).
 *
 * The result is:
 *  - percent-decoded,
 *  - normalized so that `.` segments are dropped and `..` segments pop the
 *    preceding segment (without escaping above the root),
 *  - rooted with a single leading `/`,
 *  - stripped of a single trailing slash, except the root path `/` which is
 *    preserved.
 *
 * The function is pure and never throws.
 */
export function canonicalizePath(rawPath: string): string {
  const decoded = safeDecode(rawPath ?? '');

  // Treat backslashes defensively as separators so Windows-style traversal
  // attempts collapse the same way forward-slash traversal does.
  const withForwardSlashes = decoded.replace(/\\/g, '/');

  const segments = withForwardSlashes.split('/');
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      // Skip empty segments (collapses duplicate slashes) and current-dir markers.
      continue;
    }
    if (segment === '..') {
      // Pop the previous segment; never escape above the root.
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  // Always rooted with exactly one leading slash; root collapses to '/'.
  return '/' + resolved.join('/');
}

/**
 * Determine whether a canonical path is permitted by the allowed-paths list
 * using exact match or path-segment-boundary prefix match only (Req 3.1, 3.2, 3.4).
 *
 * A path matches an allowed entry when:
 *  - it equals the entry exactly, or
 *  - it extends the entry at a path-separator boundary (the next character is `/`).
 *
 * Substring-but-not-segment matches are rejected (for example `/auth/logout-evil`
 * against `/auth/logout`). This function never consults query strings or
 * `originalUrl`; the caller must pass an already-canonicalized `req.path`.
 */
export function isPathAllowed(
  canonicalPath: string,
  allowedPaths: readonly string[],
): boolean {
  for (const allowed of allowedPaths) {
    if (canonicalPath === allowed) {
      return true;
    }
    // Segment-boundary prefix: the entry is followed immediately by '/'.
    if (canonicalPath.startsWith(allowed + '/')) {
      return true;
    }
  }
  return false;
}
