import { AsyncLocalStorage } from "async_hooks";

/**
 * Transactional event dispatch (Requirement 20).
 *
 * External events (e.g. n8n automation webhooks) must only be dispatched after
 * the database transaction that produced them has committed. While a
 * transaction is open the events are held in an in-memory, per-transaction
 * buffer (Req 20.1). On a successful commit the buffered events are dispatched
 * in the order they were buffered (Req 20.2); on rollback they are discarded
 * (Req 20.3). The buffer is released once the events have been dispatched or
 * exhausted their retry attempts (Req 20.5).
 *
 * The buffer is keyed to the active transaction via {@link AsyncLocalStorage}:
 * {@link runWithEventBuffer} establishes a buffer for the duration of a
 * transaction, and {@link enqueueEvent}/{@link flushOnCommit}/
 * {@link discardOnRollback} all operate on the buffer bound to the current
 * async context.
 */

/** A single event buffered for dispatch after the current transaction commits. */
export interface BufferedEvent {
  /** Event name (e.g. `"audit_plans.created"`). */
  name: string;
  /** Arbitrary event payload forwarded to the dispatcher unchanged. */
  payload: unknown;
}

/**
 * Dispatches a single event to the external consumer. The default
 * implementation forwards to the n8n webhook service; tests may substitute a
 * dispatcher via {@link setEventDispatcher}.
 */
export type EventDispatcher = (name: string, payload: unknown) => Promise<void>;

/** The in-memory buffer associated with a single transaction. */
interface TransactionEventBuffer {
  events: BufferedEvent[];
}

/**
 * The maximum time, in milliseconds, allowed to dispatch all buffered events
 * for a committed transaction (Req 20.2). Dispatch is initiated immediately on
 * commit and is bounded by this deadline in {@link flushOnCommit}: a single
 * dispatch is capped at the remaining budget and, once the deadline elapses,
 * any not-yet-dispatched events are abandoned.
 */
export const FLUSH_DEADLINE_MS = 5000;

const eventBufferStorage = new AsyncLocalStorage<TransactionEventBuffer>();

/**
 * The active dispatcher. Resolved lazily on first dispatch to avoid a static
 * import cycle (`db/index` → `transactionalEvents` → `n8nService` →
 * `CircuitBreaker` → `db/index`). Replaceable via {@link setEventDispatcher}.
 */
let dispatcher: EventDispatcher = async (name, payload) => {
  const { N8nService } = await import("../utils/n8nService.js");
  await N8nService.sendEvent(name, payload);
};

/**
 * Overrides the event dispatcher. Primarily intended for tests; production code
 * relies on the default n8n-backed dispatcher.
 */
export function setEventDispatcher(next: EventDispatcher): void {
  dispatcher = next;
}

/** Restores the default n8n-backed dispatcher. Intended for test teardown. */
export function resetEventDispatcher(): void {
  dispatcher = async (name, payload) => {
    const { N8nService } = await import("../utils/n8nService.js");
    await N8nService.sendEvent(name, payload);
  };
}

/**
 * Runs `fn` with a fresh, transaction-scoped event buffer in scope. The
 * {@link DBWrapper.transaction} wrapper invokes this so that any
 * {@link enqueueEvent} calls made by the transaction body are buffered rather
 * than dispatched immediately (Req 20.1).
 *
 * A nested invocation reuses the buffer already in scope so that events from an
 * inner transaction are only dispatched when the outermost transaction commits.
 */
export function runWithEventBuffer<T>(fn: () => Promise<T>): Promise<T> {
  if (eventBufferStorage.getStore()) {
    return fn();
  }
  return eventBufferStorage.run({ events: [] }, fn);
}

/** Whether an event buffer is currently in scope (i.e. inside a transaction). */
export function hasEventBuffer(): boolean {
  return eventBufferStorage.getStore() !== undefined;
}

/** Number of events currently buffered for the active transaction. */
export function bufferedEventCount(): number {
  return eventBufferStorage.getStore()?.events.length ?? 0;
}

/**
 * Buffers an event for the current transaction instead of dispatching it now
 * (Req 20.1). When called outside a transaction context (no buffer in scope)
 * there is nothing to defer to, so the event is dispatched immediately.
 */
export function enqueueEvent(event: BufferedEvent): void {
  const store = eventBufferStorage.getStore();
  if (!store) {
    // No active transaction buffer: dispatch immediately. Dispatch failures are
    // handled by the dispatcher and must never propagate to the caller.
    void dispatcher(event.name, event.payload).catch(() => {});
    return;
  }
  store.events.push(event);
}

/**
 * Dispatches all buffered events for the committed transaction, in the order
 * they were buffered (Req 20.2), then releases the buffer (Req 20.5).
 *
 * A dispatch failure for an individual event must never roll back the
 * already-committed transaction (Req 20.4); failures are absorbed here (the
 * dispatcher is responsible for retries and failure recording).
 */
export async function flushOnCommit(): Promise<void> {
  const store = eventBufferStorage.getStore();
  if (!store) {
    return;
  }
  // Drain the buffer up front so it is released regardless of dispatch outcome.
  const pending = store.events.splice(0, store.events.length);
  // Bound the total dispatch time to FLUSH_DEADLINE_MS (Req 20.2). Once the
  // deadline is reached, remaining events are abandoned rather than allowed to
  // hold the committed transaction's caller indefinitely; an individual slow
  // dispatch is likewise capped at the remaining budget.
  const deadline = Date.now() + FLUSH_DEADLINE_MS;
  for (const event of pending) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // Deadline exhausted: stop dispatching the remainder.
      break;
    }
    try {
      await withDeadline(dispatcher(event.name, event.payload), remaining);
    } catch {
      // Swallow: a failed or timed-out external dispatch must not roll back a
      // committed transaction (Req 20.4). Retry/failure recording lives in the
      // dispatcher.
    }
  }
}

/**
 * Resolves with `promise`, or rejects once `ms` milliseconds elapse, whichever
 * happens first. Used to bound a single event dispatch to the remaining flush
 * budget (Req 20.2). The timer is always cleared so it cannot keep the event
 * loop alive after the race settles.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("flush deadline exceeded")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Discards all buffered events for a rolled-back transaction so that none of
 * them are ever dispatched (Req 20.3), releasing the buffer (Req 20.5).
 */
export function discardOnRollback(): void {
  const store = eventBufferStorage.getStore();
  if (!store) {
    return;
  }
  store.events.length = 0;
}
