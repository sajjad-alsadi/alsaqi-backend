// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import winston from 'winston';
import { Writable } from 'stream';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Property 15: Structured Log Format
 * Property 16: Log Level Filtering
 *
 * **Validates: Requirements 9.1, 9.3, 9.4**
 *
 * Strategy:
 * - Property 15: Create a production-mode Winston logger with a capturing transport,
 *   log arbitrary messages, and verify every emitted log is valid JSON containing
 *   timestamp (ISO 8601), correlation_id, level, and message fields.
 * - Property 16: For any configured LOG_LEVEL, messages below that level are NOT emitted,
 *   messages at or above that level ARE emitted.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SERVICE_NAME = 'alsaqi-audit-backend';

/**
 * Winston npm levels used by the application: error=0, warn=1, info=2, debug=5
 * The application supports: error, warn, info, debug
 */
const LOG_LEVELS_HIERARCHY = ['error', 'warn', 'info', 'debug'] as const;
type LogLevel = (typeof LOG_LEVELS_HIERARCHY)[number];

/**
 * Custom transport that captures log entries synchronously via a writable stream.
 */
function createCapturingTransport(format: winston.Logform.Format) {
  const logs: string[] = [];

  const writable = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      logs.push(chunk.toString().trim());
      callback();
    },
  });

  const transport = new winston.transports.Stream({
    stream: writable,
    format,
  });

  return { transport, logs };
}

/**
 * Creates a production-like logger with the capturing transport.
 * Replicates the production format from src/utils/logger.ts
 */
function createProductionLogger(level: string, correlationStorage: AsyncLocalStorage<{ correlationId: string }>) {
  const addCorrelationId = winston.format((info) => {
    const store = correlationStorage.getStore();
    if (store) {
      info.correlation_id = store.correlationId;
    } else {
      info.correlation_id = null;
    }
    return info;
  });

  const productionFormat = winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    addCorrelationId(),
    winston.format.json()
  );

  const { transport, logs } = createCapturingTransport(productionFormat);

  const logger = winston.createLogger({
    level,
    format: productionFormat,
    defaultMeta: { service: SERVICE_NAME },
    transports: [transport],
    exitOnError: false,
  });

  return { logger, logs };
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Generate valid log messages (non-empty, printable strings without null bytes) */
const logMessageArb = fc.string({ minLength: 1, maxLength: 200 }).filter(
  (s) => s.trim().length > 0 && !s.includes('\x00')
);

/** Generate valid correlation IDs (UUID-like) */
const correlationIdArb = fc.uuid();

/** Generate a log level from the application's supported levels */
const logLevelArb = fc.constantFrom(...LOG_LEVELS_HIERARCHY);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('Property 15: Structured Log Format', () => {
  let correlationStorage: AsyncLocalStorage<{ correlationId: string }>;

  beforeEach(() => {
    correlationStorage = new AsyncLocalStorage();
  });

  it('for ANY log message emitted in production mode, output is valid JSON with required fields: timestamp (ISO 8601), correlation_id, level, message', () => {
    fc.assert(
      fc.property(
        logMessageArb,
        logLevelArb,
        correlationIdArb,
        (message, level, correlationId) => {
          const { logger, logs } = createProductionLogger('debug', correlationStorage);
          logs.length = 0;

          // Run within correlation context
          correlationStorage.run({ correlationId }, () => {
            logger[level](message);
          });

          // There should be exactly one log entry
          expect(logs.length).toBe(1);

          const logEntry = logs[0];

          // Must be valid JSON
          let parsed: Record<string, unknown>;
          expect(() => {
            parsed = JSON.parse(logEntry);
          }).not.toThrow();

          parsed = JSON.parse(logEntry);

          // Required field: timestamp (ISO 8601 format)
          expect(parsed).toHaveProperty('timestamp');
          expect(typeof parsed.timestamp).toBe('string');
          // Verify ISO 8601 format: YYYY-MM-DDTHH:mm:ss.SSS±HH:MM or ±HHMM
          const tsStr = parsed.timestamp as string;
          expect(tsStr).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:?\d{2}$/);

          // Required field: correlation_id
          expect(parsed).toHaveProperty('correlation_id');
          expect(parsed.correlation_id).toBe(correlationId);

          // Required field: level
          expect(parsed).toHaveProperty('level');
          expect(LOG_LEVELS_HIERARCHY).toContain(parsed.level);
          expect(parsed.level).toBe(level);

          // Required field: message
          expect(parsed).toHaveProperty('message');
          expect(parsed.message).toBe(message);

          // Service name should also be present (from defaultMeta)
          expect(parsed).toHaveProperty('service');
          expect(parsed.service).toBe(SERVICE_NAME);

          logger.close();
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for ANY log message without a correlation context, correlation_id is null in the output', () => {
    fc.assert(
      fc.property(
        logMessageArb,
        logLevelArb,
        (message, level) => {
          const { logger, logs } = createProductionLogger('debug', correlationStorage);
          logs.length = 0;

          // Log WITHOUT correlation context
          logger[level](message);

          expect(logs.length).toBe(1);

          const parsed = JSON.parse(logs[0]);

          // correlation_id should be null when no context is active
          expect(parsed).toHaveProperty('correlation_id');
          expect(parsed.correlation_id).toBeNull();

          // Other required fields must still be present
          expect(parsed).toHaveProperty('timestamp');
          expect(parsed).toHaveProperty('level');
          expect(parsed).toHaveProperty('message');

          logger.close();
        }
      ),
      { numRuns: 50 }
    );
  });
});

describe('Property 16: Log Level Filtering', () => {
  let correlationStorage: AsyncLocalStorage<{ correlationId: string }>;

  beforeEach(() => {
    correlationStorage = new AsyncLocalStorage();
  });

  it('for ANY configured LOG_LEVEL, messages at or above that level ARE emitted', () => {
    fc.assert(
      fc.property(
        logLevelArb,
        logMessageArb,
        (configuredLevel, message) => {
          const { logger, logs } = createProductionLogger(configuredLevel, correlationStorage);

          const configuredIndex = LOG_LEVELS_HIERARCHY.indexOf(configuredLevel);

          // Log at all levels that should be emitted (level index <= configuredIndex)
          const emittedLevels = LOG_LEVELS_HIERARCHY.filter(
            (_lvl, idx) => idx <= configuredIndex
          );

          for (const level of emittedLevels) {
            logs.length = 0;
            logger[level](`${message}-${level}`);

            // Message at or above configured level MUST be emitted
            expect(logs.length).toBe(1);

            const parsed = JSON.parse(logs[0]);
            expect(parsed.level).toBe(level);
            expect(parsed.message).toBe(`${message}-${level}`);
          }

          logger.close();
        }
      ),
      { numRuns: 50 }
    );
  });

  it('for ANY configured LOG_LEVEL, messages below that level are NOT emitted', () => {
    fc.assert(
      fc.property(
        logLevelArb,
        logMessageArb,
        (configuredLevel, message) => {
          const { logger, logs } = createProductionLogger(configuredLevel, correlationStorage);

          const configuredIndex = LOG_LEVELS_HIERARCHY.indexOf(configuredLevel);

          // Levels that should be filtered out (level index > configuredIndex)
          const filteredLevels = LOG_LEVELS_HIERARCHY.filter(
            (_lvl, idx) => idx > configuredIndex
          );

          for (const level of filteredLevels) {
            logs.length = 0;
            logger[level](`${message}-${level}`);

            // Message below configured level MUST NOT be emitted
            expect(logs.length).toBe(0);
          }

          logger.close();
        }
      ),
      { numRuns: 50 }
    );
  });

  it('for ANY LOG_LEVEL=error, only error messages are emitted, not warn/info/debug', () => {
    fc.assert(
      fc.property(
        logMessageArb,
        (message) => {
          const { logger, logs } = createProductionLogger('error', correlationStorage);

          // Error should be emitted
          logs.length = 0;
          logger.error(message);
          expect(logs.length).toBe(1);
          expect(JSON.parse(logs[0]).level).toBe('error');

          // Warn, info, debug should NOT be emitted
          logs.length = 0;
          logger.warn(message);
          expect(logs.length).toBe(0);

          logs.length = 0;
          logger.info(message);
          expect(logs.length).toBe(0);

          logs.length = 0;
          logger.debug(message);
          expect(logs.length).toBe(0);

          logger.close();
        }
      ),
      { numRuns: 50 }
    );
  });

  it('for ANY LOG_LEVEL=debug (most verbose), ALL levels are emitted', () => {
    fc.assert(
      fc.property(
        logMessageArb,
        (message) => {
          const { logger, logs } = createProductionLogger('debug', correlationStorage);

          for (const level of LOG_LEVELS_HIERARCHY) {
            logs.length = 0;
            logger[level](`${message}-${level}`);
            expect(logs.length).toBe(1);
            expect(JSON.parse(logs[0]).level).toBe(level);
          }

          logger.close();
        }
      ),
      { numRuns: 50 }
    );
  });
});
