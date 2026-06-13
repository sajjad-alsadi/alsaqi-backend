// @vitest-environment node
// Feature: backend-security-hardening, Property 28: Transactional event buffering
//
// **Validates: Requirements 20.1, 20.2, 20.3, 20.5**
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  enqueueEvent,
  flushOnCommit,
  discardOnRollback,
  runWithEventBuffer,
  hasEventBuffer,
  bufferedEventCount,
  setEventDispatcher,
  resetEventDispatcher,
  type BufferedEvent,
} from '../transactionalEvents';

/**
 * Property 28: Transactional event buffering
 *
 * For any sequence of events emitted during a database transaction:
 *   1. No external dispatch occurs while the transaction is open — each event is
 *      held in the in-memory, per-transaction buffer (Req 20.1).
 *   2. On commit, the buffered events are dispatched in the order they were
 *      buffered (Req 20.2)...
 *   3. ...and the buffer is then released (Req 20.5).
 *   4. On rollback, all buffered events are discarded, none are dispatched, and
 *      the buffer is released (Req 20.3, 20.5).
 */

// ─── Generators ──────────────────────────────────────────────────────────────

/** A single bufferable event. Names/payloads span the practical input space. */
const eventArb: fc.Arbitrary<BufferedEvent> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 40 }),
  payload: fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.record({ id: fc.integer(), label: fc.string() }),
  ),
});

/** A sequence of events emitted during one transaction. */
const eventSeqArb = fc.array(eventArb, { minLength: 0, maxLength: 20 });

// ─── Property ────────────────────────────────────────────────────────────────

describe('Feature: backend-security-hardening, Property 28: Transactional event buffering', () => {
  afterEach(() => {
    resetEventDispatcher();
  });

  it('buffers while open, dispatches in order on commit and discards on rollback (Req 20.1, 20.2, 20.3, 20.5)', async () => {
    await fc.assert(
      fc.asyncProperty(eventSeqArb, fc.boolean(), async (events, commit) => {
        // Record every external dispatch the buffer triggers, in dispatch order.
        const dispatched: BufferedEvent[] = [];
        setEventDispatcher(async (name, payload) => {
          dispatched.push({ name, payload });
        });

        await runWithEventBuffer(async () => {
          // (1) While the transaction is open every event is buffered, never
          //     dispatched immediately (Req 20.1).
          events.forEach((event, index) => {
            enqueueEvent(event);
            expect(bufferedEventCount()).toBe(index + 1);
          });
          expect(hasEventBuffer()).toBe(true);
          expect(dispatched).toHaveLength(0);

          if (commit) {
            await flushOnCommit();

            // (2) On commit, buffered events are dispatched in buffer order (Req 20.2).
            expect(dispatched).toEqual(events);
          } else {
            discardOnRollback();

            // (4) On rollback, nothing is ever dispatched (Req 20.3).
            expect(dispatched).toHaveLength(0);
          }

          // (3)/(4) The buffer is released regardless of outcome (Req 20.5).
          expect(bufferedEventCount()).toBe(0);
        });
      }),
      { numRuns: 100 },
    );
  });
});
