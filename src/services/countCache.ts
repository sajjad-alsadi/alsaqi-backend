/**
 * Cached total-count source for large-table list endpoints (Requirement 6.5).
 *
 * Executing an unbounded `COUNT(*)` on every list request does not scale on
 * large tables. For keyset-configured (large-table) endpoints, the total count
 * is instead served from a short-lived in-memory cache: the first request for a
 * given table+filter computes the count once and caches it; subsequent requests
 * within the TTL reuse the cached value, so the returned count is never older
 * than {@link COUNT_CACHE_TTL_MS} (≤ 60 s) without running `COUNT(*)` per
 * request.
 *
 * This module is intentionally side-effect-light and testable: the clock and TTL
 * are injectable, and {@link clearCountCache} resets state between tests.
 */

/** A cached count value with its absolute expiry timestamp (ms epoch). */
interface CountCacheEntry {
  value: number;
  expiresAt: number;
}

/**
 * Maximum age of a cached count, in milliseconds. Set to 60 000 ms so a served
 * count is never older than 60 seconds (Req 6.5).
 */
export const COUNT_CACHE_TTL_MS = 60_000;

const cache = new Map<string, CountCacheEntry>();

/**
 * Returns a total count for `key`, serving a cached value when it is still
 * fresh (age ≤ `ttlMs`) and otherwise invoking `loader` once and caching its
 * result (Req 6.5).
 *
 * @param key - Cache key uniquely identifying the table + filter combination
 * @param loader - Async function that computes the authoritative count on a miss
 * @param ttlMs - Cache freshness window in ms (defaults to {@link COUNT_CACHE_TTL_MS})
 * @param now - Current time in ms epoch (injectable for tests; defaults to `Date.now()`)
 * @returns The cached or freshly computed total count
 */
export async function getCachedCount(
  key: string,
  loader: () => Promise<number>,
  ttlMs: number = COUNT_CACHE_TTL_MS,
  now: number = Date.now()
): Promise<number> {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > now) {
    return entry.value;
  }

  const value = await loader();
  cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/**
 * Builds a stable cache key from a table name and its bound where-clause inputs
 * so that distinct filters are counted independently.
 *
 * @param tableName - The target table name
 * @param whereClause - The composed SQL where clause (or empty string)
 * @param whereValues - The bound parameter values for the where clause
 */
export function buildCountCacheKey(
  tableName: string,
  whereClause: string,
  whereValues: readonly unknown[]
): string {
  return `${tableName}\u0000${whereClause}\u0000${JSON.stringify(whereValues)}`;
}

/**
 * Clears all cached counts. Intended for tests and for explicit invalidation.
 */
export function clearCountCache(): void {
  cache.clear();
}
