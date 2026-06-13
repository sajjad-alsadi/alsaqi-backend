import { redisManager } from '../cache/redisManager.js';
import logger from '../utils/logger.js';
import { permissionCache } from './PermissionCache';

/**
 * AuthCacheInvalidator — the single canonical path for invalidating a user's
 * cached authentication state (Requirement 16).
 *
 * Every account suspend/disable path and every role/permission-change path calls
 * `AuthCacheInvalidator.invalidate(userId)` so that cached authorization data can
 * never outlive the authoritative change. Consolidating invalidation here removes
 * the previously scattered, best-effort `invalidateUserCache` /
 * `PermissionService.invalidateCache` calls that each handled only part of the
 * cached state.
 *
 * Behaviour:
 * - Clears the in-process permission-resolution cache for the user (Req 16.2).
 * - Deletes the distributed Redis auth-cache entries for the user (Req 16.1).
 * - Retries the Redis invalidation up to 3 times on failure; if every attempt
 *   fails, the user is flagged for a forced authoritative re-read on the next
 *   request and an error identifying the account is recorded (Req 16.4).
 *
 * The auth middleware consults {@link AuthCacheInvalidator.shouldForceRead} to
 * bypass the cache for any flagged user, and re-reads status/role from the
 * authoritative store rather than serving stale cached values (Req 16.3).
 */

const AUTH_CACHE_PREFIX = 'auth:';

/** Maximum number of Redis invalidation attempts before forcing a DB re-read (Req 16.4). */
export const MAX_INVALIDATION_ATTEMPTS = 3;

/**
 * In-process set of user IDs whose cached auth state could not be invalidated
 * after exhausting all retry attempts. The auth middleware reads this set to
 * force a fresh read from the authoritative store on the next request for that
 * user, bypassing any potentially stale cached entry (Req 16.4). The flag is
 * cleared once a fresh authoritative read succeeds, or once a later invalidation
 * succeeds.
 */
const forceReadUserIds = new Set<string>();

/**
 * Delete every Redis auth-cache entry for a user. Auth-cache keys are of the
 * form `auth:<prefix>_<userId>_<session_version>`, so a userId-scoped pattern
 * removes entries across all session versions. Throws on any Redis error so the
 * caller can retry. Returns the number of keys deleted.
 */
const deleteUserAuthCacheKeys = async (userId: string): Promise<number> => {
  const client = redisManager.getClient();
  if (!client) return 0;

  const pattern = `${AUTH_CACHE_PREFIX}*_${userId}_*`;
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      deleted += await client.del(...keys);
    }
  } while (cursor !== '0');

  return deleted;
};

export const AuthCacheInvalidator = {
  /**
   * Invalidate all cached authentication state for a user. This is the canonical
   * entry point invoked from every suspend/disable and role/permission-change
   * path (Req 16.1, 16.2).
   *
   * Never throws: Redis failures are retried up to {@link MAX_INVALIDATION_ATTEMPTS}
   * times and, on exhaustion, the user is flagged for a forced authoritative
   * re-read and an error is recorded (Req 16.4).
   */
  async invalidate(userId: string): Promise<void> {
    if (!userId) return;

    // Always clear the in-process permission-resolution cache (best-effort, never
    // throws) so role/permission changes take effect on the next check (Req 16.2).
    permissionCache.invalidateUser(userId);

    // When Redis is unavailable there is no distributed cache entry to remove and
    // the auth middleware already reads straight from the authoritative store, so
    // nothing can be served stale. Treat this as a successful invalidation.
    if (!redisManager.isAvailable) {
      forceReadUserIds.delete(userId);
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_INVALIDATION_ATTEMPTS; attempt++) {
      try {
        await deleteUserAuthCacheKeys(userId);
        // Success: the user is re-read fresh on the next request (Req 16.1-16.3).
        forceReadUserIds.delete(userId);
        return;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[AuthCacheInvalidator] Invalidation attempt ${attempt}/${MAX_INVALIDATION_ATTEMPTS} ` +
            `failed for user ${userId}: ${message}`,
        );
      }
    }

    // All attempts failed: force a DB re-read on the next request and record an
    // error indication identifying the affected account (Req 16.4).
    forceReadUserIds.add(userId);
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    logger.error(
      `[AuthCacheInvalidator] Failed to invalidate cached auth state for user ${userId} after ` +
        `${MAX_INVALIDATION_ATTEMPTS} attempts; forcing authoritative re-read on next request. ` +
        `Last error: ${message}`,
    );
  },

  /**
   * Whether the next request for this user must bypass the cache and re-read
   * from the authoritative store because a prior invalidation failed (Req 16.4).
   */
  shouldForceRead(userId: string): boolean {
    return forceReadUserIds.has(userId);
  },

  /**
   * Clear the forced-re-read flag for a user. Called by the auth middleware after
   * a fresh authoritative read succeeds.
   */
  clearForceRead(userId: string): void {
    forceReadUserIds.delete(userId);
  },

  /** Test helper: reset all in-process invalidation state. */
  _reset(): void {
    forceReadUserIds.clear();
  },
};
