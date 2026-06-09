import winston from 'winston';
import { AsyncLocalStorage } from 'async_hooks';

const { combine, timestamp, printf, colorize, json } = winston.format;

// Correlation ID storage for request tracing
export const requestContext = new AsyncLocalStorage<{ correlationId: string; userId?: string }>();

const addCorrelationId = winston.format((info) => {
  const store = requestContext.getStore();
  if (store) {
    info.correlationId = store.correlationId;
    if (store.userId) {
      info.userId = store.userId;
    }
  }
  return info;
});

const logFormat = printf(({ level, message, timestamp, correlationId, ...metadata }) => {
  const corrId = correlationId ? `[${correlationId}]` : '';
  let msg = `${timestamp} [${level}]${corrId}: ${message}`;
  if (Object.keys(metadata).length > 0 && metadata.service === undefined) {
    try {
      const filtered = { ...metadata };
      delete filtered.service;
      if (Object.keys(filtered).length > 0) {
        msg += ` ${JSON.stringify(filtered)}`;
      }
    } catch (e) {
      msg += ` [Metadata contains circular references or is not stringifiable]`;
    }
  }
  return msg;
});

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    addCorrelationId(),
    process.env.NODE_ENV === 'production' ? json() : combine(json())
  ),
  defaultMeta: { service: 'alsaqi-audit-backend' },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production'
        ? combine(
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            addCorrelationId(),
            json()
          )
        : combine(
            colorize(),
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            addCorrelationId(),
            logFormat
          ),
    }),
  ],
});

export default logger;
