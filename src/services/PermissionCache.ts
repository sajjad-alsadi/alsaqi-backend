/**
 * PermissionCache - LRU cache for permission check results.
 *
 * Stores permission check results with key format: `perm_{userId}_{module}_{action}`
 * Default: max 1000 entries with 5-minute TTL and LRU eviction.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7
 */

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

export class PermissionCache {
  private store: Map<string, CacheEntry>;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  /**
   * @param maxEntries Maximum number of entries before LRU eviction (default: 1000)
   * @param ttlMinutes Time-to-live in minutes for each entry (default: 5)
   */
  constructor(maxEntries = 1000, ttlMinutes = 5) {
    this.store = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  /**
   * Get a cached permission result.
   * Returns undefined on cache miss or expired entry.
   * Req 5.2, 5.7 (graceful fallback on failure)
   */
  get(key: string): boolean | undefined {
    try {
      const entry = this.store.get(key);
      if (!entry) return undefined;

      // Check TTL expiration (entry valid while now <= expiresAt)
      if (Date.now() > entry.expiresAt) {
        this.store.delete(key);
        return undefined;
      }

      // Move to end of Map for LRU ordering (most recently accessed = last)
      this.store.delete(key);
      this.store.set(key, entry);

      return entry.value;
    } catch (e) {
      // Req 5.7: graceful fallback on cache failure
      console.warn('[PermissionCache] get failed:', e);
      return undefined;
    }
  }

  /**
   * Store a permission result in cache.
   * Req 5.1: key format `perm_{userId}_{module}_{action}`, TTL 5 minutes
   * Req 5.6: max entries with LRU eviction
   */
  set(key: string, value: boolean): void {
    try {
      // If key already exists, delete it first to update LRU order
      if (this.store.has(key)) {
        this.store.delete(key);
      } else if (this.store.size >= this.maxEntries) {
        // Evict LRU entry (first entry in Map iteration order)
        const firstKey = this.store.keys().next().value;
        if (firstKey !== undefined) {
          this.store.delete(firstKey);
        }
      }

      this.store.set(key, {
        value,
        expiresAt: Date.now() + this.ttlMs,
      });
    } catch (e) {
      // Req 5.7: graceful fallback on cache failure - silently warn
      console.warn('[PermissionCache] set failed:', e);
    }
  }

  /**
   * Invalidate all cache entries for a specific user.
   * Removes entries matching prefix `perm_{userId}_`
   * Req 5.3
   */
  invalidateUser(userId: string): void {
    try {
      const prefix = `perm_${userId}_`;
      for (const key of this.store.keys()) {
        if (key.startsWith(prefix)) {
          this.store.delete(key);
        }
      }
    } catch (e) {
      console.warn('[PermissionCache] invalidateUser failed:', e);
    }
  }

  /**
   * Invalidate all permission cache entries (prefix `perm_`).
   * Req 5.4
   */
  invalidateAll(): void {
    try {
      for (const key of this.store.keys()) {
        if (key.startsWith('perm_')) {
          this.store.delete(key);
        }
      }
    } catch (e) {
      console.warn('[PermissionCache] invalidateAll failed:', e);
    }
  }

  /**
   * Get current cache size.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Clear entire cache (for testing).
   */
  _reset(): void {
    this.store.clear();
  }
}

/** Default singleton PermissionCache instance (1000 entries, 5-min TTL) */
export const permissionCache = new PermissionCache();
