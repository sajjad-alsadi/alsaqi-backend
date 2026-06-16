/**
 * WebSocket JWT Authentication
 *
 * Handles token extraction from a request header (or the
 * `Sec-WebSocket-Protocol` subprotocol for browser clients that cannot set
 * custom headers) and verification using RS256 algorithm.
 *
 * The token is never read from the `?token=` query string because query strings
 * are commonly logged by reverse proxies and access logs, leaking the bearer
 * credential. A dedicated, short-lived ws token (`type==='ws'`) is required and
 * the user's current `session_version`/`status` is re-checked against the
 * authoritative store so revoked or disabled users are rejected (Req 2.27).
 */

import jwt from 'jsonwebtoken';
import type { IncomingMessage } from 'http';
import { db } from '../db/index';
import { isLoginBlockedStatus } from '../services/accountStatus';

export interface WsAuthPayload {
  id: string;
  username: string;
  role?: string;
}

/**
 * Extracts the bearer token from the upgrade request without touching the query
 * string. Two transports are supported:
 *
 * 1. `Authorization: Bearer <token>` — preferred for non-browser clients.
 * 2. `Sec-WebSocket-Protocol: bearer, <token>` — for browser `WebSocket`
 *    clients, which cannot set arbitrary headers but can declare subprotocols.
 *
 * @returns The raw token string, or null if none is present.
 */
function extractToken(request: IncomingMessage): string | null {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1]) {
      return parts[1];
    }
  }

  const subprotocol = request.headers['sec-websocket-protocol'];
  if (typeof subprotocol === 'string') {
    const values = subprotocol.split(',').map((value) => value.trim()).filter(Boolean);
    // Format: ['bearer', '<token>'] (preferred) or a bare ['<token>'].
    if (values.length >= 2 && values[0].toLowerCase() === 'bearer') {
      return values[1];
    }
    if (values.length === 1) {
      return values[0];
    }
  }

  return null;
}

/**
 * Extracts and verifies the JWT token from the WebSocket upgrade request.
 *
 * Verification enforces, in addition to a valid RS256 signature:
 * - the token is a dedicated ws token (`decoded.type === 'ws'`); a generic
 *   access token is rejected.
 * - the user still exists and is active (non-blocked `status`).
 * - the token's `session_version` still matches the user's current
 *   `session_version`, so forced-logout / password-reset revocation applies.
 *
 * @param request - The HTTP upgrade request
 * @param jwtPublicKey - The RSA public key for RS256 verification
 * @returns The decoded token payload, or null if auth fails
 */
export async function authenticateWsRequest(
  request: IncomingMessage,
  jwtPublicKey: string
): Promise<WsAuthPayload | null> {
  try {
    const token = extractToken(request);

    if (!token) {
      return null;
    }

    const decoded = jwt.verify(token, jwtPublicKey, {
      algorithms: ['RS256'],
    }) as any;

    if (!decoded || !decoded.id) {
      return null;
    }

    // Require a dedicated ws token; reject generic access/refresh tokens (Req 2.27).
    if (decoded.type !== 'ws') {
      return null;
    }

    // Re-check the authoritative user record so revoked/disabled accounts are
    // rejected even while a short-lived ws token is still cryptographically
    // valid (Req 2.27).
    const user = await db.prepare(
      'SELECT id, username, role, status, session_version FROM users WHERE id = ?'
    ).get(decoded.id) as any;

    if (!user) {
      return null;
    }

    // Block any non-active account (suspended/inactive/archived/disabled).
    if (isLoginBlockedStatus(user.status)) {
      return null;
    }

    // Reject tokens whose session_version no longer matches the user's current
    // session_version (e.g. after a password reset / forced logout bumped it).
    if (
      decoded.session_version !== undefined &&
      decoded.session_version !== user.session_version
    ) {
      return null;
    }

    return {
      id: user.id,
      username: user.username,
      role: user.role,
    };
  } catch {
    return null;
  }
}
