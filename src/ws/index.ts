/**
 * WebSocket Server Module
 *
 * Handles WebSocket connections for real-time notifications in the API package.
 *
 * Features:
 * - JWT authentication via the `Authorization` header / `Sec-WebSocket-Protocol`
 *   subprotocol on upgrade (a dedicated ws token is required)
 * - Server-initiated ping every 30 seconds with 10-second pong timeout
 * - Real-time notification delivery within 2 seconds of triggering event
 *
 * Requirements: 9.1, 6.5
 */

import type { Server as HttpServer } from 'http';
import type { WebSocketServer, WebSocket } from 'ws';

import { authenticateWsRequest } from './auth.js';
import { startHeartbeat, initClientHeartbeat } from './heartbeat.js';
import { broadcastToUsers, broadcastToAll, getConnectedClientCount } from './notifications.js';
import type { AuthenticatedWs, WsNotificationPayload } from './notifications.js';

export type { AuthenticatedWs, WsNotificationPayload } from './notifications.js';
export type { WsAuthPayload } from './auth.js';
export { broadcastToUsers, broadcastToAll, getConnectedClientCount } from './notifications.js';

export interface WsSetupOptions {
  /** The HTTP server to handle upgrade events on */
  httpServer: HttpServer;
  /** The WebSocketServer instance (created with noServer: true) */
  wss: WebSocketServer;
  /** RSA public key for JWT verification */
  jwtPublicKey: string;
  /** Optional logger (defaults to console) */
  logger?: {
    info: (msg: string, ...args: any[]) => void;
    error: (msg: string, ...args: any[]) => void;
    warn: (msg: string, ...args: any[]) => void;
  };
}

/**
 * Sets up the WebSocket server with authentication, heartbeat, and connection handling.
 *
 * This function:
 * 1. Registers the HTTP upgrade handler (JWT auth via header/subprotocol)
 * 2. Registers the WebSocket connection handler (sets user context)
 * 3. Starts the heartbeat interval (ping every 30s, terminate if no pong within 10s)
 *
 * @returns A cleanup function to stop the heartbeat and remove listeners
 */
export function setupWebSocket(options: WsSetupOptions): () => void {
  const { httpServer, wss, jwtPublicKey, logger = console } = options;

  // ─── HTTP Upgrade Handler ─────────────────────────────────────────────────
  // Requires a dedicated ws JWT (type==='ws') via the Authorization header or
  // Sec-WebSocket-Protocol subprotocol for immediate authentication

  const upgradeHandler = (
    request: import('http').IncomingMessage,
    socket: import('stream').Duplex,
    head: Buffer
  ) => {
    // Authentication re-checks the authoritative user record, so it is async.
    // Any failure (invalid/expired/non-ws token, revoked session, blocked
    // account, or store error) is treated as unauthorized.
    void authenticateWsRequest(request, jwtPublicKey)
      .then((authPayload) => {
        if (!authPayload) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          // Attach authenticated user info to the WebSocket connection
          const authenticatedWs = ws as unknown as AuthenticatedWs;
          authenticatedWs.userId = authPayload.id;
          authenticatedWs.username = authPayload.username;
          authenticatedWs.authenticated = true;
          authenticatedWs.connectedAt = Date.now();

          wss.emit('connection', ws, request);
        });
      })
      .catch((err) => {
        logger.error('WebSocket upgrade authentication failed:', err);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
  };

  httpServer.on('upgrade', upgradeHandler);

  // ─── Connection Handler ───────────────────────────────────────────────────
  // All connections are pre-authenticated during the upgrade phase

  wss.on('connection', (ws: WebSocket) => {
    // Initialize heartbeat tracking for this client
    initClientHeartbeat(ws);
  });

  // ─── Error Handler ────────────────────────────────────────────────────────

  wss.on('error', (err: Error) => {
    logger.error('WebSocketServer Error:', err);
  });

  // ─── Heartbeat ────────────────────────────────────────────────────────────
  // Server-initiated ping every 30 seconds, terminate if no pong within 10 seconds

  const stopHeartbeat = startHeartbeat(wss);

  // ─── Cleanup Function ─────────────────────────────────────────────────────

  return () => {
    stopHeartbeat();
    httpServer.removeListener('upgrade', upgradeHandler);
  };
}
