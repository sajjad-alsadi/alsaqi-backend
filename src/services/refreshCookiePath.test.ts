import { describe, it, expect, afterEach } from 'vitest';
import {
  buildRefreshCookiePath,
  getRefreshCookiePath,
  DEFAULT_API_PREFIX,
  DEFAULT_REFRESH_ROUTE,
} from './refreshCookiePath';

describe('buildRefreshCookiePath (Requirement 19)', () => {
  it('combines the configured prefix with the refresh route (Req 19.1)', () => {
    expect(buildRefreshCookiePath('/api/v1')).toBe('/api/v1/auth/refresh');
  });

  it('honours a non-default prefix (Req 19.2)', () => {
    expect(buildRefreshCookiePath('/api/v2')).toBe('/api/v2/auth/refresh');
    expect(buildRefreshCookiePath('/gateway/api')).toBe('/gateway/api/auth/refresh');
  });

  it('falls back to the default prefix for absent/empty/whitespace values (Req 19.3)', () => {
    expect(buildRefreshCookiePath(undefined)).toBe(`${DEFAULT_API_PREFIX}/auth/refresh`);
    expect(buildRefreshCookiePath(null)).toBe(`${DEFAULT_API_PREFIX}/auth/refresh`);
    expect(buildRefreshCookiePath('')).toBe(`${DEFAULT_API_PREFIX}/auth/refresh`);
    expect(buildRefreshCookiePath('   ')).toBe(`${DEFAULT_API_PREFIX}/auth/refresh`);
  });

  it('normalizes to exactly one leading slash (Req 19.4)', () => {
    expect(buildRefreshCookiePath('api/v1')).toBe('/api/v1/auth/refresh');
    expect(buildRefreshCookiePath('///api/v1')).toBe('/api/v1/auth/refresh');
  });

  it('removes trailing slashes except the root (Req 19.4)', () => {
    expect(buildRefreshCookiePath('/api/v1/')).toBe('/api/v1/auth/refresh');
    expect(buildRefreshCookiePath('/api/v1', '/auth/refresh/')).toBe('/api/v1/auth/refresh');
  });

  it('collapses internal duplicate slashes (Req 19.4)', () => {
    expect(buildRefreshCookiePath('/api//v1', '//auth//refresh')).toBe('/api/v1/auth/refresh');
  });

  it('trims surrounding whitespace on the prefix', () => {
    expect(buildRefreshCookiePath('  /api/v1  ')).toBe('/api/v1/auth/refresh');
  });

  it('uses the default refresh route when none is supplied', () => {
    expect(buildRefreshCookiePath('/api/v1')).toBe(`/api/v1${DEFAULT_REFRESH_ROUTE}`);
  });

  it('supports a custom refresh route', () => {
    expect(buildRefreshCookiePath('/api/v1', '/sessions/renew')).toBe('/api/v1/sessions/renew');
  });
});

describe('getRefreshCookiePath (Requirement 19.5)', () => {
  const originalPrefix = process.env.API_PREFIX;

  afterEach(() => {
    if (originalPrefix === undefined) {
      delete process.env.API_PREFIX;
    } else {
      process.env.API_PREFIX = originalPrefix;
    }
  });

  it('computes from the currently configured prefix at call time (Req 19.5)', () => {
    process.env.API_PREFIX = '/api/v1';
    expect(getRefreshCookiePath()).toBe('/api/v1/auth/refresh');

    // A prefix change between calls is reflected on the next call.
    process.env.API_PREFIX = '/api/v9';
    expect(getRefreshCookiePath()).toBe('/api/v9/auth/refresh');
  });

  it('falls back to the default prefix when API_PREFIX is unset (Req 19.3)', () => {
    delete process.env.API_PREFIX;
    expect(getRefreshCookiePath()).toBe(`${DEFAULT_API_PREFIX}/auth/refresh`);
  });
});
