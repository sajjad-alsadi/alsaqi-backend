import crypto from 'crypto';
import { db } from '../db/index';

/**
 * AuditChainService
 *
 * The single, canonical writer for the tamper-evident audit hash-chain
 * (`audit_trail`). This replaces the duplicated `logAudit` hash-chain writers
 * previously embedded in `BaseService` and `AuthService` (Requirement 7.1,
 * 27.1): no other component may insert, modify, or delete chain entries.
 *
 * Chain semantics:
 *  - Each entry stores a SHA-256 `hash` computed over its own content together
 *    with the `previous_hash` (the hash of the immediately preceding entry).
 *  - The genesis entry uses the sentinel previous-hash `'0'`.
 *  - Appends are serialized so the read-prev-hash -> compute -> insert steps
 *    run as one atomic, mutually-exclusive critical section (Requirement 7.2).
 */

/**
 * Application-defined PostgreSQL advisory-lock key for the audit chain.
 *
 * Used with `pg_advisory_xact_lock` so that concurrent appends across separate
 * connections (and process instances) are serialized at the database level.
 * The lock is transaction-scoped and released automatically on COMMIT/ROLLBACK.
 */
const AUDIT_CHAIN_LOCK_KEY = 728_193_004;

/** The sentinel previous-hash value used by the genesis (first) chain entry. */
const GENESIS_PREVIOUS_HASH = '0';

/** Input accepted when appending a single entry to the audit chain. */
export interface AuditEntryInput {
  /** The acting user (stored in the `"user"` column). */
  user: string;
  /** The action performed. */
  action: string;
  /** The module/area the action belongs to. */
  module: string;
  /** Free-form details describing the action. */
  details: string;
}

/** Reason an end-to-end chain verification failed. */
export type VerificationFailureReason = 'hash-mismatch' | 'fork' | 'gap';

/** Result of {@link AuditChainService.verifyChain}. */
export type VerifyChainResult =
  | { valid: true }
  | { valid: false; firstOffendingId: string; reason: VerificationFailureReason };

/** Internal shape of a row read from `audit_trail` during verification. */
interface AuditTrailRow {
  id: string | number;
  user: string;
  action: string;
  module: string;
  details: string;
  hash: string;
  previous_hash: string;
  /**
   * The stored timestamp as read back from the database. Depending on the
   * driver/engine this is either an ISO string or a `Date` (PostgreSQL/PGlite
   * return `TIMESTAMPTZ` columns as `Date`), so it is canonicalized before
   * hashing — see {@link canonicalizeTimestamp}.
   */
  timestamp: string | Date;
}

/**
 * Canonicalizes a timestamp to a single, stable string representation used for
 * hashing.
 *
 * The hash-chain contract hashes the timestamp as an ISO-8601 string. The value
 * hashed at append time MUST be byte-for-byte identical to the value hashed at
 * verify time, but the timestamp read back from the database is a `Date` (or a
 * driver-specific string), not the original ISO string. Routing both the
 * append-time and verify-time timestamp through this function guarantees the
 * same canonical ISO-8601 string is hashed in both code paths, so the
 * append-then-verify round trip is deterministic (Requirement 7.4).
 */
function canonicalizeTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

/**
 * Computes the canonical chain hash for an entry.
 *
 * The field ordering and separator are part of the on-disk contract and must
 * remain stable so that previously written entries continue to verify.
 */
function computeEntryHash(
  previousHash: string,
  user: string,
  action: string,
  module: string,
  details: string,
  timestamp: string
): string {
  const recordData = `${previousHash}|${user}|${action}|${module}|${details}|${timestamp}`;
  return crypto.createHash('sha256').update(recordData).digest('hex');
}

export class AuditChainService {
  /**
   * Appends exactly one entry to the audit chain.
   *
   * Reading the previous hash, computing the new hash, and inserting the row
   * run inside a single transaction guarded by a mutually-exclusive lock, so
   * concurrent appends cannot interleave these steps (Requirement 7.2, 7.3):
   *  - For external PostgreSQL, `pg_advisory_xact_lock` serializes appends
   *    across connections and process instances.
   *  - For the embedded PGlite engine, the transaction already holds the
   *    process-wide exclusive write lock for its full duration.
   *
   * If any step fails before the insert is durably committed, the enclosing
   * transaction rolls back so the chain remains in its pre-append state with no
   * partial entry persisted, and the error propagates to the caller as a
   * failure indication (Requirement 7.5).
   */
  static async append(entry: AuditEntryInput): Promise<void> {
    const { user, action, module, details } = entry;

    await db.transaction(async () => {
      // Serialize appends across connections/instances. In PGlite mode the
      // transaction already holds the exclusive write lock, so the advisory
      // lock is only needed for external PostgreSQL.
      if (db.isExternal) {
        await db.exec(`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`);
      }

      // Canonical ISO-8601 timestamp. This exact string is what gets hashed,
      // and verifyChain canonicalizes the read-back value identically so the
      // recomputed hash matches (Requirement 7.4).
      const timestamp = canonicalizeTimestamp(new Date());

      // Read the committed tail of the chain under the lock. Order by the
      // strictly-increasing insertion sequence (`seq`) rather than `timestamp`:
      // multiple appends can land in the same millisecond, so a timestamp-only
      // ordering has no deterministic tiebreaker and concurrent (or same-ms)
      // appends could read the same predecessor and fork the chain. `seq` is a
      // monotonic identity column, so `ORDER BY seq DESC LIMIT 1` always selects
      // the true latest committed entry (Requirement 7.2, 7.3).
      const lastRecord = (await db
        .prepare(
          'SELECT hash FROM audit_trail WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1'
        )
        .get()) as { hash?: string } | undefined;

      const previousHash = lastRecord?.hash ?? GENESIS_PREVIOUS_HASH;

      const hash = computeEntryHash(previousHash, user, action, module, details, timestamp);

      await db
        .prepare(
          'INSERT INTO audit_trail ("user", action, module, details, hash, previous_hash, timestamp) ' +
            'VALUES (?::text, ?::text, ?::text, ?::text, ?::text, ?::text, ?::timestamptz)'
        )
        .run(user, action, module, details, hash, previousHash, timestamp);
    });
  }

  /**
   * Verifies the audit chain end to end (Requirement 7.4, 7.6).
   *
   * For every entry, the stored hash is recomputed from the entry's recorded
   * content and recorded previous-hash and compared to the stored value. The
   * chain is valid only when every recomputed hash matches, every non-genesis
   * previous-hash links to exactly one existing prior entry, and no two entries
   * share a previous-hash (no fork) and no referenced predecessor is missing
   * (no gap).
   *
   * On failure, the first offending entry in chain order is reported along with
   * the failure category. No chain entry is modified.
   */
  static async verifyChain(): Promise<VerifyChainResult> {
    const rows = (await db
      .prepare(
        'SELECT id, "user", action, module, details, hash, previous_hash, timestamp ' +
          'FROM audit_trail WHERE hash IS NOT NULL ORDER BY seq ASC'
      )
      .all()) as AuditTrailRow[];

    if (rows.length === 0) {
      return { valid: true };
    }

    // Pass 1: recompute every entry's hash from its recorded content +
    // recorded previous-hash and confirm it matches the stored hash.
    for (const row of rows) {
      const recomputed = computeEntryHash(
        row.previous_hash,
        row.user,
        row.action,
        row.module,
        row.details,
        canonicalizeTimestamp(row.timestamp)
      );
      if (recomputed !== row.hash) {
        return { valid: false, firstOffendingId: String(row.id), reason: 'hash-mismatch' };
      }
    }

    // Index entries by their (now-verified) hash and count how many entries
    // reference each previous-hash to detect forks.
    const byHash = new Map<string, AuditTrailRow>();
    for (const row of rows) {
      byHash.set(row.hash, row);
    }

    const previousHashCounts = new Map<string, number>();
    for (const row of rows) {
      previousHashCounts.set(
        row.previous_hash,
        (previousHashCounts.get(row.previous_hash) ?? 0) + 1
      );
    }

    // Pass 2: verify single-predecessor linkage in chain order, reporting the
    // first entry that introduces a fork or gap.
    for (const row of rows) {
      const prev = row.previous_hash;

      if (prev === GENESIS_PREVIOUS_HASH) {
        // More than one genesis entry means the chain forks at its root.
        if ((previousHashCounts.get(GENESIS_PREVIOUS_HASH) ?? 0) > 1) {
          return { valid: false, firstOffendingId: String(row.id), reason: 'fork' };
        }
        continue;
      }

      // Gap: the previous-hash does not link to any existing prior entry.
      if (!byHash.has(prev)) {
        return { valid: false, firstOffendingId: String(row.id), reason: 'gap' };
      }

      // Fork: two or more entries share the same previous-hash.
      if ((previousHashCounts.get(prev) ?? 0) > 1) {
        return { valid: false, firstOffendingId: String(row.id), reason: 'fork' };
      }
    }

    return { valid: true };
  }
}

export default AuditChainService;
