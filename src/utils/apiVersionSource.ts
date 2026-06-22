/**
 * Single source of truth for the X-API-Version response header value.
 *
 * Every `/api` response derives its `X-API-Version` header from this one
 * constant so the value is consistent across the whole server (including
 * early-rejection responses such as 413/404) and never conflicts with a
 * hardcoded alternative.
 *
 * The value equals Shared_API_Version (the full semver `API_VERSION` exported
 * from `@alsaqi/shared`), except when the `API_VERSION` environment variable is
 * set to a non-empty trimmed value, in which case that override is used.
 *
 * Requirements: 3.1, 3.3
 */

import { API_VERSION } from '@alsaqi/shared';

export const VERSION_SOURCE = process.env.API_VERSION?.trim() || API_VERSION;
