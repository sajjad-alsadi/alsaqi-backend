// @vitest-environment node
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PermissionCache } from '../PermissionCache';

describe('PermissionCache', () => {
  let cache: PermissionCache;

  beforeEach(() => {
    cache = new PermissionCache(1000, 5);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('get/set', () => {
    it('should return undefined for a cache miss', () => {
      expect(cache.get('perm_user1_Analytics_View')).toBeUndefined();
    });

    it('should store and retrieve a true value', () => {
      cache.set('perm_user1_Analytics_View', true);
      expect(cache.get('perm_user1_Analytics_View')).toBe(true);
    });

    it('should store and retrieve a false value', () => {
      cache.set('perm_user1_Policies_Delete', false);
      expect(cache.get('perm_user1_Policies_Delete')).toBe(false);
    });

    it('should update an existing entry', () => {
      cache.set('perm_user1_Analytics_View', true);
      cache.set('perm_user1_Analytics_View', false);
      expect(cache.get('perm_user1_Analytics_View')).toBe(false);
    });

    it('should return undefined for expired entries', () => {
      cache.set('perm_user1_Analytics_View', true);

      // Advance time past TTL (5 minutes)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      expect(cache.get('perm_user1_Analytics_View')).toBeUndefined();
    });

    it('should return value for non-expired entries', () => {
      cache.set('perm_user1_Analytics_View', true);

      // Advance time but stay within TTL
      vi.advanceTimersByTime(4 * 60 * 1000);

      expect(cache.get('perm_user1_Analytics_View')).toBe(true);
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used entry when at capacity', () => {
      const smallCache = new PermissionCache(3, 5);

      smallCache.set('perm_u1_M1_View', true);
      smallCache.set('perm_u1_M2_View', true);
      smallCache.set('perm_u1_M3_View', true);

      // Cache is full, adding a new entry should evict the LRU (M1)
      smallCache.set('perm_u1_M4_View', true);

      expect(smallCache.get('perm_u1_M1_View')).toBeUndefined();
      expect(smallCache.get('perm_u1_M2_View')).toBe(true);
      expect(smallCache.get('perm_u1_M3_View')).toBe(true);
      expect(smallCache.get('perm_u1_M4_View')).toBe(true);
    });

    it('should not evict recently accessed entries', () => {
      const smallCache = new PermissionCache(3, 5);

      smallCache.set('perm_u1_M1_View', true);
      smallCache.set('perm_u1_M2_View', true);
      smallCache.set('perm_u1_M3_View', true);

      // Access M1 to make it most recently used
      smallCache.get('perm_u1_M1_View');

      // Adding new entry should evict M2 (now the LRU)
      smallCache.set('perm_u1_M4_View', true);

      expect(smallCache.get('perm_u1_M1_View')).toBe(true);
      expect(smallCache.get('perm_u1_M2_View')).toBeUndefined();
      expect(smallCache.get('perm_u1_M3_View')).toBe(true);
      expect(smallCache.get('perm_u1_M4_View')).toBe(true);
    });

    it('should enforce max 1000 entries with default config', () => {
      const defaultCache = new PermissionCache();

      for (let i = 0; i < 1001; i++) {
        defaultCache.set(`perm_user_Module${i}_View`, true);
      }

      expect(defaultCache.size).toBe(1000);
      // First entry should have been evicted
      expect(defaultCache.get('perm_user_Module0_View')).toBeUndefined();
      // Last entry should exist
      expect(defaultCache.get('perm_user_Module1000_View')).toBe(true);
    });

    it('should update LRU order when set is called on existing key', () => {
      const smallCache = new PermissionCache(3, 5);

      smallCache.set('perm_u1_M1_View', true);
      smallCache.set('perm_u1_M2_View', true);
      smallCache.set('perm_u1_M3_View', true);

      // Update M1 to make it most recently used
      smallCache.set('perm_u1_M1_View', false);

      // Adding new entry should evict M2 (now the LRU)
      smallCache.set('perm_u1_M4_View', true);

      expect(smallCache.get('perm_u1_M1_View')).toBe(false);
      expect(smallCache.get('perm_u1_M2_View')).toBeUndefined();
    });
  });

  describe('invalidateUser', () => {
    it('should remove all entries for a specific user', () => {
      cache.set('perm_user1_Analytics_View', true);
      cache.set('perm_user1_Policies_Create', true);
      cache.set('perm_user1_Policies_Edit', false);
      cache.set('perm_user2_Analytics_View', true);

      cache.invalidateUser('user1');

      expect(cache.get('perm_user1_Analytics_View')).toBeUndefined();
      expect(cache.get('perm_user1_Policies_Create')).toBeUndefined();
      expect(cache.get('perm_user1_Policies_Edit')).toBeUndefined();
      expect(cache.get('perm_user2_Analytics_View')).toBe(true);
    });

    it('should not affect entries for other users', () => {
      cache.set('perm_user1_Analytics_View', true);
      cache.set('perm_user2_Analytics_View', true);
      cache.set('perm_user3_Analytics_View', true);

      cache.invalidateUser('user2');

      expect(cache.get('perm_user1_Analytics_View')).toBe(true);
      expect(cache.get('perm_user2_Analytics_View')).toBeUndefined();
      expect(cache.get('perm_user3_Analytics_View')).toBe(true);
    });

    it('should handle invalidating a user with no entries', () => {
      cache.set('perm_user1_Analytics_View', true);

      // Should not throw
      cache.invalidateUser('nonexistent');

      expect(cache.get('perm_user1_Analytics_View')).toBe(true);
    });
  });

  describe('invalidateAll', () => {
    it('should remove all permission entries', () => {
      cache.set('perm_user1_Analytics_View', true);
      cache.set('perm_user2_Policies_Create', false);
      cache.set('perm_user3_AuditPlans_Edit', true);

      cache.invalidateAll();

      expect(cache.get('perm_user1_Analytics_View')).toBeUndefined();
      expect(cache.get('perm_user2_Policies_Create')).toBeUndefined();
      expect(cache.get('perm_user3_AuditPlans_Edit')).toBeUndefined();
      expect(cache.size).toBe(0);
    });
  });

  describe('graceful error handling', () => {
    it('get should return undefined and not throw on internal error', () => {
      // Corrupt internal state to trigger error
      const brokenCache = new PermissionCache();
      (brokenCache as any).store = { get: () => { throw new Error('Simulated failure'); } };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = brokenCache.get('perm_user1_Analytics_View');

      expect(result).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('set should not throw on internal error', () => {
      const brokenCache = new PermissionCache();
      (brokenCache as any).store = { has: () => { throw new Error('Simulated failure'); } };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => brokenCache.set('perm_user1_Analytics_View', true)).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('invalidateUser should not throw on internal error', () => {
      const brokenCache = new PermissionCache();
      (brokenCache as any).store = { keys: () => { throw new Error('Simulated failure'); } };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => brokenCache.invalidateUser('user1')).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('invalidateAll should not throw on internal error', () => {
      const brokenCache = new PermissionCache();
      (brokenCache as any).store = { keys: () => { throw new Error('Simulated failure'); } };

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => brokenCache.invalidateAll()).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('size', () => {
    it('should report correct size', () => {
      expect(cache.size).toBe(0);

      cache.set('perm_user1_M1_View', true);
      expect(cache.size).toBe(1);

      cache.set('perm_user1_M2_View', false);
      expect(cache.size).toBe(2);

      cache.invalidateUser('user1');
      expect(cache.size).toBe(0);
    });
  });

  describe('TTL behavior', () => {
    it('should refresh TTL when entry is updated via set', () => {
      cache.set('perm_user1_Analytics_View', true);

      // Advance 4 minutes
      vi.advanceTimersByTime(4 * 60 * 1000);

      // Update the entry (refreshes TTL)
      cache.set('perm_user1_Analytics_View', true);

      // Advance another 4 minutes (total 8 from first set, 4 from update)
      vi.advanceTimersByTime(4 * 60 * 1000);

      // Should still be valid since TTL was refreshed
      expect(cache.get('perm_user1_Analytics_View')).toBe(true);
    });

    it('should expire exactly at TTL boundary', () => {
      cache.set('perm_user1_Analytics_View', true);

      // Advance exactly to TTL
      vi.advanceTimersByTime(5 * 60 * 1000);

      // At exactly TTL, entry should still be valid (expiresAt = now + ttl, check is > not >=)
      expect(cache.get('perm_user1_Analytics_View')).toBe(true);

      // One ms past TTL
      vi.advanceTimersByTime(1);
      expect(cache.get('perm_user1_Analytics_View')).toBeUndefined();
    });
  });
});
