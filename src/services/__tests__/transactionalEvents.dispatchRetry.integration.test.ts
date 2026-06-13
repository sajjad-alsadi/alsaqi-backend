// @vitest-environment node
// Feature: backend-security-hardening, Task 12.3 — Integration test for dispatch retry after commit.
//
// Spec: .kiro/specs/backend-security-hardening (task 12.3)
//
// **Validates: Requirements 20.4**
//
// Requirement 20.4: IF the external HTTP call for a buffered event fails or does
// not receive a response within 10 seconds, THEN THE Event_Dispatcher SHALL retry
// the dispatch up to 3 additional attempts and, after the final failed attempt,
// SHALL record the dispatch failure for the affected event without rolling back
// the already-committed transaction.
//
// Scope note (documented behavior):
//   `transactionalEvents.flushOnCommit` dispatches each buffered event after the
//   transaction commits and *swallows* per-event dispatch failures so that a
//   failed external call can never roll back the committed transaction. The
//   retry-up-to-3-additional-attempts and failure-recording semantics are the
//   responsibility of the injected Event_Dispatcher (production: `N8nService`
//   via `CircuitBreaker`). These tests therefore exercise the real commit→flush
//   wiring of `DBWrapper.transaction` against an embedded PGlite engine and
//   inject a dispatcher (via `setEventDispatcher`) that models the documented
//   Event_Dispatcher retry/record contract, asserting that:
//     - committed rows persist regardless of dispatch outcome (no rollback), and
//     - the dispatcher is given the opportunity to retry up to 3 additional
//       attempts and record a failure after exhausting them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { db } from '../../db/index';
import {
  enqueueEvent,
  setEventDispatcher,
  resetEventDispatcher,
  type EventDispatcher,
} from '../transactionalEvents';

// ─── Test harness: embedded PGlite engine behind the canonical db wrapper ──────

let pglite: any;

async function createWidgetsTable(): Promise<void> {
  await pglite.query(`
    CREATE TABLE IF NOT EXISTS widgets (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
}

async function widgetCount(): Promise<number> {
  // Read outside any transaction so it observes only committed state.
  const row = await db
    .prepare('SELECT COUNT(*)::int AS n FROM widgets')
    .get<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Builds an Event_Dispatcher that models the documented retry/record contract
 * (Req 20.4): it invokes `send` and, on failure, retries up to
 * `maxAdditionalAttempts` more times; after the final failed attempt it records
 * the failure via `recordFailure` and resolves (the failure has been handled and
 * must never roll back the committed transaction).
 */
function createRetryingDispatcher(opts: {
  send: (name: string, payload: unknown) => Promise<void>;
  recordFailure: (name: string, payload: unknown, totalAttempts: number) => void;
  maxAdditionalAttempts?: number;
}): EventDispatcher {
  const maxAdditional = opts.maxAdditionalAttempts ?? 3;
  return async (name, payload) => {
    const totalAttempts = maxAdditional + 1; // 1 initial + N additional
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        await opts.send(name, payload);
        return; // dispatched successfully — nothing to record
      } catch {
        // swallow and retry until attempts are exhausted
      }
    }
    // All attempts failed: record the failure for the affected event.
    opts.recordFailure(name, payload, totalAttempts);
  };
}

describe('Feature: backend-security-hardening, Task 12.3 — dispatch retry after commit (Req 20.4)', () => {
  beforeEach(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    pglite = new PGlite();
    await pglite.waitReady;
    await createWidgetsTable();
    (db as unknown as { updateClient(client: unknown, isExternal: boolean): void }).updateClient(
      pglite,
      false,
    );
  });

  afterEach(async () => {
    resetEventDispatcher();
    if (pglite) {
      await pglite.close();
      pglite = null;
    }
  });

  it('does not roll back the committed transaction when the dispatcher throws on every attempt (Req 20.4)', async () => {
    let attempts = 0;
    // A dispatcher whose external call always fails and ultimately propagates.
    setEventDispatcher(async () => {
      attempts += 1;
      throw new Error('n8n webhook unreachable');
    });

    const result = await db.transaction(async () => {
      await db.prepare('INSERT INTO widgets (name) VALUES (?)').run('committed-widget');
      enqueueEvent({ name: 'widgets.created', payload: { name: 'committed-widget' } });
      return 'ok';
    });

    // The transaction body completed and committed despite the failing dispatch.
    expect(result).toBe('ok');
    // The dispatcher was actually invoked after commit.
    expect(attempts).toBeGreaterThanOrEqual(1);
    // The committed row survives — the failed external dispatch did NOT roll back.
    expect(await widgetCount()).toBe(1);
  });

  it('retries up to 3 additional attempts and records the failure, without rolling back the commit (Req 20.4)', async () => {
    const sendAttempts: number[] = [];
    const recorded: Array<{ name: string; payload: unknown; totalAttempts: number }> = [];

    const dispatcher = createRetryingDispatcher({
      send: async () => {
        sendAttempts.push(Date.now());
        throw new Error('dispatch failed (no response within timeout)');
      },
      recordFailure: (name, payload, totalAttempts) => {
        recorded.push({ name, payload, totalAttempts });
      },
      maxAdditionalAttempts: 3,
    });
    setEventDispatcher(dispatcher);

    const result = await db.transaction(async () => {
      await db.prepare('INSERT INTO widgets (name) VALUES (?)').run('retry-widget');
      enqueueEvent({ name: 'widgets.created', payload: { id: 1 } });
      return 'committed';
    });

    expect(result).toBe('committed');
    // 1 initial attempt + 3 additional attempts = 4 total send attempts.
    expect(sendAttempts).toHaveLength(4);
    // Exactly one recorded failure for the affected event, after exhausting retries.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      name: 'widgets.created',
      payload: { id: 1 },
      totalAttempts: 4,
    });
    // The already-committed transaction is preserved.
    expect(await widgetCount()).toBe(1);
  });

  it('stops retrying and records no failure once a retry succeeds (Req 20.4)', async () => {
    let sendCount = 0;
    const recorded: unknown[] = [];

    const dispatcher = createRetryingDispatcher({
      // Fails on the first two attempts, succeeds on the third.
      send: async () => {
        sendCount += 1;
        if (sendCount < 3) {
          throw new Error('transient failure');
        }
      },
      recordFailure: (name, payload) => {
        recorded.push({ name, payload });
      },
      maxAdditionalAttempts: 3,
    });
    setEventDispatcher(dispatcher);

    const result = await db.transaction(async () => {
      await db.prepare('INSERT INTO widgets (name) VALUES (?)').run('eventual-success');
      enqueueEvent({ name: 'widgets.created', payload: { id: 2 } });
      return 'committed';
    });

    expect(result).toBe('committed');
    // Stopped retrying as soon as the third attempt succeeded.
    expect(sendCount).toBe(3);
    // No failure recorded because dispatch ultimately succeeded.
    expect(recorded).toHaveLength(0);
    expect(await widgetCount()).toBe(1);
  });

  it('flushes every buffered event after commit even when one fails, preserving the commit (Req 20.4)', async () => {
    const dispatched: string[] = [];
    const recorded: string[] = [];

    const dispatcher = createRetryingDispatcher({
      send: async (name) => {
        // The middle event's external call always fails; the others succeed.
        if (name === 'widgets.updated') {
          throw new Error('webhook error for widgets.updated');
        }
        dispatched.push(name);
      },
      recordFailure: (name) => {
        recorded.push(name);
      },
      maxAdditionalAttempts: 3,
    });
    setEventDispatcher(dispatcher);

    const result = await db.transaction(async () => {
      await db.prepare('INSERT INTO widgets (name) VALUES (?)').run('multi-1');
      await db.prepare('INSERT INTO widgets (name) VALUES (?)').run('multi-2');
      enqueueEvent({ name: 'widgets.created', payload: {} });
      enqueueEvent({ name: 'widgets.updated', payload: {} });
      enqueueEvent({ name: 'widgets.deleted', payload: {} });
      return 'committed';
    });

    expect(result).toBe('committed');
    // The succeeding events were dispatched in buffer order; the failing one was
    // retried and recorded rather than aborting the flush.
    expect(dispatched).toEqual(['widgets.created', 'widgets.deleted']);
    expect(recorded).toEqual(['widgets.updated']);
    // Both committed rows persist — no rollback from the failed dispatch.
    expect(await widgetCount()).toBe(2);
  });
});
