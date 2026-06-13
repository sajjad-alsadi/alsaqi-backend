import { getApiPrefix, CONFIG_DEFAULTS } from '../config/environmentConfig';

/**
 * Configurable refresh-cookie path (Requirement 19).
 *
 * The refresh-token cookie must be scoped to the exact path at which the refresh
 * endpoint is served. Because the API prefix is configurable (`API_PREFIX`, default
 * `/api/v1`), the cookie path is derived from the *current* configured prefix combined
 * with the refresh route, rather than being hardcoded. This guarantees the browser
 * sends the refresh cookie back to the refresh endpoint regardless of the deployed
 * prefix, and that issuance and clearing always use a matching path.
 *
 * Requirements:
 * - 19.1 Cookie path = configured API prefix combined with the refresh endpoint route, so
 *        the resulting path exactly matches where the refresh endpoint is served.
 * - 19.2 With a non-default prefix, the client sends the refresh cookie to the refresh endpoint.
 * - 19.3 Absent/empty/whitespace-only prefix falls back to the default API prefix.
 * - 19.4 Normalize to exactly one leading "/" and no trailing "/", except the root "/".
 * - 19.5 The path is computed from the prefix configured at issuance time (read live), so a
 *        prefix change between issuance and a later request uses the then-current prefix.
 */

/** Default API prefix applied when the configured prefix is absent/empty/whitespace (Req 19.3). */
export const DEFAULT_API_PREFIX: string = CONFIG_DEFAULTS.apiPrefix;

/** Refresh endpoint route relative to the API prefix (auth router is mounted at `/auth`). */
export const DEFAULT_REFRESH_ROUTE = '/auth/refresh';

/**
 * Normalizes a raw path to begin with exactly one leading "/" and contain no trailing
 * "/" (except the root "/"), collapsing any internal runs of slashes (Req 19.4).
 *
 * @param raw - The unnormalized path.
 * @returns The normalized path, never empty (at minimum "/").
 */
function normalizePath(raw: string): string {
  // Trim surrounding whitespace, then collapse every run of slashes to a single slash.
  let path = (raw ?? '').trim().replace(/\/{2,}/g, '/');

  // Guarantee exactly one leading slash.
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  // Strip any trailing slash(es) unless the whole path is the root "/".
  if (path.length > 1) {
    path = path.replace(/\/+$/, '');
  }

  return path.length === 0 ? '/' : path;
}

/**
 * Resolves the effective API prefix, applying the default when the configured value is
 * absent, empty, or whitespace-only (Req 19.3).
 *
 * @param apiPrefix - The configured API prefix, which may be absent or whitespace-only.
 * @returns A non-empty prefix string (the default when the input is unusable).
 */
function resolvePrefix(apiPrefix: string | null | undefined): string {
  if (typeof apiPrefix !== 'string' || apiPrefix.trim().length === 0) {
    return DEFAULT_API_PREFIX;
  }
  return apiPrefix.trim();
}

/**
 * Builds the refresh-cookie path by combining the configured API prefix with the refresh
 * endpoint route and normalizing the result (Req 19.1, 19.3, 19.4).
 *
 * The combined path begins with exactly one leading "/", contains no trailing "/" (unless
 * it is the root "/"), and contains no internal duplicate slashes, so it exactly matches
 * the path at which the refresh endpoint is served (Req 19.1, 19.2).
 *
 * @param apiPrefix - The configured API prefix (e.g. "/api/v1"). Absent/empty/whitespace
 *                    values fall back to {@link DEFAULT_API_PREFIX} (Req 19.3).
 * @param refreshRoute - The refresh route relative to the prefix; defaults to
 *                       {@link DEFAULT_REFRESH_ROUTE}.
 * @returns The normalized refresh-cookie path (e.g. "/api/v1/auth/refresh").
 */
export function buildRefreshCookiePath(
  apiPrefix: string | null | undefined,
  refreshRoute: string = DEFAULT_REFRESH_ROUTE,
): string {
  const prefix = resolvePrefix(apiPrefix);
  const route = typeof refreshRoute === 'string' ? refreshRoute : DEFAULT_REFRESH_ROUTE;
  // Join with an explicit separator; normalizePath collapses any resulting duplicate slashes.
  return normalizePath(`${prefix}/${route}`);
}

/**
 * Returns the refresh-cookie path computed from the *currently* configured API prefix
 * (read live from configuration at call time) combined with the refresh route (Req 19.5).
 *
 * Cookie issuance and clearing call this at request time so the path always reflects the
 * prefix in effect for that request, never a value captured at module load.
 *
 * @param refreshRoute - The refresh route relative to the prefix; defaults to
 *                       {@link DEFAULT_REFRESH_ROUTE}.
 * @returns The normalized refresh-cookie path for the current configuration.
 */
export function getRefreshCookiePath(refreshRoute: string = DEFAULT_REFRESH_ROUTE): string {
  return buildRefreshCookiePath(getApiPrefix(), refreshRoute);
}
