/**
 * logQuery — pure helpers that mirror the Log_Aggregator (Loki) query semantics
 * for the `production-launch-readiness` spec, design region (ي-14).
 *
 * The real query path runs inside Loki via a LogQL filter such as:
 *
 *     {service="alsaqi-api"} | json | traceId="<the-trace-id>"
 *
 * selected over a `start`/`end` time range. Because Loki is not running in unit
 * tests, this module encodes the *semantics* of that query so they can be
 * asserted directly:
 *
 *   - Req 14.5 — a time-range + `traceId` query returns every entry whose
 *                timestamp falls inside the range AND whose `traceId` matches.
 *   - Req 14.6 — a query that matches nothing returns an EMPTY result set
 *                (`[]`), never an error / throw.
 *
 * `filterLogsByTraceId` is the JS mirror of the LogQL `| json | traceId="..."`
 * filter over a range: no match ⇒ `[]` (no throw); matching entries ⇒ returned.
 */

/** A single structured log line as shipped to / queried from the aggregator. */
export interface LogEntry {
  /** Emission time — epoch milliseconds, an ISO-8601 string, or a Date. */
  timestamp: number | string | Date;
  /** Correlation id carried in the JSON body (the shipper guarantees presence). */
  traceId?: string;
  [key: string]: unknown;
}

/** An inclusive query time range, expressed in epoch milliseconds. */
export interface TimeRange {
  /** Range start (inclusive), epoch milliseconds. */
  start: number;
  /** Range end (inclusive), epoch milliseconds. */
  end: number;
}

/** Normalises a log timestamp to epoch milliseconds, or NaN if unparseable. */
function toEpochMs(timestamp: LogEntry['timestamp']): number {
  if (typeof timestamp === 'number') return timestamp;
  if (timestamp instanceof Date) return timestamp.getTime();
  return new Date(timestamp).getTime();
}

/**
 * Mirrors the Loki LogQL query `... | json | traceId="<traceId>"` evaluated over
 * a time range.
 *
 * Returns every entry whose timestamp is within `[range.start, range.end]`
 * (inclusive) and whose `traceId` equals the requested value (Req 14.5).
 *
 * When nothing matches — whether because no entry carries the `traceId` or none
 * falls inside the range — it returns an EMPTY array and never throws (Req 14.6).
 *
 * @param entries  the candidate log entries (e.g. a stream scanned by the query)
 * @param traceId  the correlation id to match exactly
 * @param range    the inclusive time range to scan
 */
export function filterLogsByTraceId(
  entries: ReadonlyArray<LogEntry>,
  traceId: string,
  range: TimeRange,
): LogEntry[] {
  // Defensive: a non-array input is treated as "no entries to scan" rather than
  // an error, preserving the empty-result-not-an-error contract of Req 14.6.
  if (!Array.isArray(entries)) return [];

  return entries.filter((entry) => {
    const ts = toEpochMs(entry?.timestamp);
    if (Number.isNaN(ts)) return false; // unparseable timestamp ⇒ not in range
    const inRange = ts >= range.start && ts <= range.end;
    return inRange && entry?.traceId === traceId;
  });
}
