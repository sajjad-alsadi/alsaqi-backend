/**
 * Account-status enforcement shared between {@link AuthService.login} and the
 * `authenticate` middleware (Requirement 2.2).
 *
 * The authoritative database CHECK constraint on `users.status` permits exactly
 * `'Active'`, `'Inactive'`, and `'Suspended'`. Only an `'Active'` account may
 * authenticate; every other (non-active) status is blocked. Centralizing the
 * rule here guarantees the login path and the request gate agree on the same
 * single set of blocked statuses, instead of each maintaining its own divergent
 * check (the source of defect 1.2).
 */

/** The only account status permitted to authenticate. */
export const ACTIVE_STATUS = 'Active';

/**
 * Statuses that block authentication. Includes the schema-permitted non-active
 * values (`'Inactive'`, `'Suspended'`) plus legacy/defensive values that may
 * still appear in older rows (`'Disabled'`, `'Archived'`). This list is
 * documentary; {@link isLoginBlockedStatus} is the authoritative predicate and
 * treats any non-`Active` status as blocked.
 */
export const BLOCKED_LOGIN_STATUSES: readonly string[] = [
  'Inactive',
  'Suspended',
  'Disabled',
  'Archived',
];

/**
 * Returns `true` when an account with the given status must be blocked from
 * authenticating. Any status other than `'Active'` (including `null`/`undefined`)
 * is treated as blocked so that {@link AuthService.login} and the `authenticate`
 * middleware enforce identical behavior for every non-active status.
 */
export function isLoginBlockedStatus(status: string | null | undefined): boolean {
  return status !== ACTIVE_STATUS;
}
