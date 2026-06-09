/**
 * WebSocket JWT Authentication
 *
 * Handles token extraction from the `?token=` query parameter
 * and verification using RS256 algorithm.
 */

import jwt from 'jsonwebtoken';
import type { IncomingMessage } from 'http';

export interface WsAuthPayload {
  id: string;
  username: string;
  role?: string;
}

/**
 * Extracts and verifies the JWT token from the WebSocket upgrade request.
 *
 * @param request - The HTTP upgrade request
 * @param jwtPublicKey - The RSA public key for RS256 verification
 * @returns The decoded token payload, or null if auth fails
 */
export function authenticateWsRequest(
  request: IncomingMessage,
  jwtPublicKey: string
): WsAuthPayload | null {
  try {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      return null;
    }

    const decoded = jwt.verify(token, jwtPublicKey, {
      algorithms: ['RS256'],
    }) as any;

    if (!decoded || !decoded.id) {
      return null;
    }

    return {
      id: decoded.id,
      username: decoded.username,
      role: decoded.role,
    };
  } catch {
    return null;
  }
}
