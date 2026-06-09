import { Request, Response, NextFunction } from 'express';
import { IdempotencyOptions } from '../types/middleware';
import db from '../db/index';

/**
 * In-memory set tracking idempotency keys currently being processed.
 * Used to detect and reject duplicate in-flight requests with 409 Conflict.
 */
const inFlightKeys = new Set<string>();

/**
 * Builds a composite key scoping the idempotency key to the authenticated user.
 */
function compositeKey(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

/**
 * IdempotencyService provides static methods for checking, storing, and cleaning up
 * idempotency records in the database.
 */
export class IdempotencyService {
  /**
   * Check for an existing non-expired idempotency record matching the key and user.
   * Returns the stored record if found and not expired, otherwise null.
   */
  static async check(
    idempotencyKey: string,
    userId: string,
    method: string,
    path: string
  ): Promise<{ response_status: number; response_body: string } | null> {
    const record = await db.prepare(
      `SELECT response_status, response_body FROM idempotency_keys
       WHERE idempotency_key = ? AND user_id = ? AND method = ? AND path = ? AND expires_at > NOW()`
    ).get(idempotencyKey, userId, method, path);

    return record || null;
  }

  /**
   * Store a response for the given idempotency key and user.
   * The record will expire after the configured TTL.
   */
  static async store(
    idempotencyKey: string,
    userId: string,
    method: string,
    path: string,
    responseStatus: number,
    responseBody: string,
    ttlSeconds: number
  ): Promise<void> {
    await db.prepare(
      `INSERT INTO idempotency_keys (idempotency_key, user_id, method, path, response_status, response_body, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW() + INTERVAL '1 second' * ?)`
    ).run(idempotencyKey, userId, method, path, responseStatus, responseBody, ttlSeconds);
  }

  /**
   * Remove expired idempotency records from the database.
   */
  static async cleanup(): Promise<void> {
    await db.prepare(`DELETE FROM idempotency_keys WHERE expires_at <= NOW()`).run();
  }
}

/**
 * Creates an idempotency middleware for POST/PUT requests.
 *
 * Behavior:
 * 1. Only applies to configured HTTP methods (default: POST, PUT)
 * 2. Validates the X-Idempotency-Key header (1-256 characters)
 * 3. Returns 400 for empty or >256 character keys
 * 4. Returns 409 Conflict if the same key is currently being processed (in-flight)
 * 5. Returns the stored response for a matching key + user without re-executing
 * 6. On first execution, stores the response with configurable TTL (default: 24 hours)
 * 7. Keys are scoped per authenticated user to prevent cross-user collisions
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7
 */
export function createIdempotencyMiddleware(options: IdempotencyOptions = {}) {
  const {
    headerName = 'X-Idempotency-Key',
    ttl = 86400, // 24 hours in seconds
    methods = ['POST', 'PUT'],
  } = options;

  const normalizedHeaderName = headerName.toLowerCase();

  return async (req: Request, res: Response, next: NextFunction) => {
    // Only apply to configured methods
    if (!methods.includes(req.method.toUpperCase())) {
      return next();
    }

    // Check if the header is present
    const idempotencyKey = req.headers[normalizedHeaderName] as string | undefined;

    // If no idempotency key header is provided, skip idempotency processing
    if (idempotencyKey === undefined) {
      return next();
    }

    // Validate key length: must be 1-256 characters
    if (!idempotencyKey || idempotencyKey.length === 0 || idempotencyKey.length > 256) {
      return res.status(400).json({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'X-Idempotency-Key must be between 1 and 256 characters',
      });
    }

    // Require authenticated user for idempotency scoping
    const user = (req as any).user;
    if (!user || !user.id) {
      return next();
    }

    const userId = user.id;
    const method = req.method.toUpperCase();
    const requestPath = req.originalUrl || req.path;
    const key = compositeKey(userId, idempotencyKey);

    try {
      // Check for in-flight duplicate
      if (inFlightKeys.has(key)) {
        return res.status(409).json({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'A request with this idempotency key is already being processed',
        });
      }

      // Check for existing stored response
      const existing = await IdempotencyService.check(idempotencyKey, userId, method, requestPath);
      if (existing) {
        // Return stored response without re-executing
        const storedBody = JSON.parse(existing.response_body);
        return res.status(existing.response_status).json(storedBody);
      }

      // Mark key as in-flight
      inFlightKeys.add(key);

      // Override res.json to capture the response and store it
      const originalJson = res.json.bind(res);

      res.json = ((body: any): Response => {
        const statusCode = res.statusCode;

        // Store the response asynchronously (fire-and-forget)
        IdempotencyService.store(
          idempotencyKey,
          userId,
          method,
          requestPath,
          statusCode,
          JSON.stringify(body),
          ttl
        )
          .catch((err) => {
            console.error(
              `[Idempotency] Failed to store response for key "${idempotencyKey}":`,
              err instanceof Error ? err.message : String(err)
            );
          })
          .finally(() => {
            // Remove from in-flight set
            inFlightKeys.delete(key);
          });

        return originalJson(body);
      }) as any;

      // If the response ends without json (e.g., error), clean up in-flight
      res.on('finish', () => {
        // Delayed cleanup in case json was called synchronously before finish
        setTimeout(() => {
          inFlightKeys.delete(key);
        }, 100);
      });

      next();
    } catch (err) {
      // On any error, remove from in-flight and pass to error handler
      inFlightKeys.delete(key);
      next(err);
    }
  };
}

/**
 * Default idempotency middleware instance with standard options.
 * Header: X-Idempotency-Key, TTL: 24 hours, Methods: POST, PUT
 */
export const idempotencyMiddleware = createIdempotencyMiddleware();

/**
 * Utility to clear in-flight keys (for testing purposes).
 */
export function clearInFlightKeys(): void {
  inFlightKeys.clear();
}

/**
 * Utility to check if a key is in-flight (for testing purposes).
 */
export function isKeyInFlight(userId: string, idempotencyKey: string): boolean {
  return inFlightKeys.has(compositeKey(userId, idempotencyKey));
}
