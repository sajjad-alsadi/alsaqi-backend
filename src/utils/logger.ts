import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { AsyncLocalStorage } from 'async_hooks';

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

// Correlation ID storage for request tracing
export const requestContext = new AsyncLocalStorage<{ correlationId: string; userId?: string }>();

const SERVICE_NAME = 'alsaqi-audit-backend';
const isProduction = process.env.NODE_ENV === 'production';

// Resolve log level: LOG_LEVEL env var takes precedence, defaults to 'info'
const validLevels = ['error', 'warn', 'info', 'debug'];
const configuredLevel = process.env.LOG_LEVEL?.toLowerCase() ?? 'info';
const logLevel = validLevels.includes(configuredLevel) ? configuredLevel : 'info';

/**
 * Custom format that injects correlation_id from AsyncLocalStorage
 */
const addCorrelationId = winston.format((info) => {
  const store = requestContext.getStore();
  if (store) {
    info.correlation_id = store.correlationId;
    if (store.userId) {
      info.userId = store.userId;
    }
  } else {
    info.correlation_id = null;
  }
  return info;
});

/**
 * Human-readable format for development/non-production environments
 */
const devLogFormat = printf(({ level, message, timestamp, correlation_id, ...metadata }) => {
  const corrId = correlation_id ? `[${correlation_id}]` : '';
  let msg = `${timestamp} [${level}]${corrId}: ${message}`;
  if (Object.keys(metadata).length > 0) {
    const filtered = { ...metadata };
    delete filtered.service;
    if (Object.keys(filtered).length > 0) {
      try {
        msg += ` ${JSON.stringify(filtered)}`;
      } catch {
        msg += ` [Metadata contains circular references]`;
      }
    }
  }
  return msg;
});

/**
 * Production JSON format ensuring required fields are present:
 * timestamp (ISO 8601), correlation_id, level, message, service
 */
const productionFormat = combine(
  errors({ stack: true }),
  timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }), // ISO 8601
  addCorrelationId(),
  json()
);

/**
 * Development format with colorized output
 */
const developmentFormat = combine(
  errors({ stack: true }),
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  addCorrelationId(),
  devLogFormat
);

// Build transports array based on environment
const transports: winston.transport[] = [];

if (isProduction) {
  // Production: Daily rotating file transport
  const fileTransport = new DailyRotateFile({
    dirname: process.env.LOG_DIR || 'logs',
    filename: 'alsaqi-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '50m',        // Max 50MB per file
    maxFiles: '30d',       // Retain for 30 days, auto-delete older
    zippedArchive: true,   // Compress old files
    format: productionFormat,
  });

  // Fallback to stdout on file write failure (e.g., disk full)
  fileTransport.on('error', (error) => {
    // Log to stderr that file transport failed, then stdout takes over
    console.error(`[Logger] File transport error, falling back to stdout: ${error.message}`);
  });

  // Add stdout (Console) transport as fallback — always present in production
  // to ensure logs are captured even when file writes fail
  const consoleTransport = new winston.transports.Console({
    format: productionFormat,
  });

  transports.push(fileTransport);
  transports.push(consoleTransport);
} else {
  // Non-production: Console transport with human-readable format
  transports.push(
    new winston.transports.Console({
      format: developmentFormat,
    })
  );
}

const logger = winston.createLogger({
  level: logLevel,
  format: productionFormat, // Default format (overridden per transport)
  defaultMeta: { service: SERVICE_NAME },
  transports,
  // In production, if all transports fail, don't crash the app
  exitOnError: false,
});

// Handle uncaught transport errors gracefully — fallback to stdout
logger.on('error', (error) => {
  console.error(`[Logger] Unhandled logger error: ${error.message}`);
});

export default logger;
