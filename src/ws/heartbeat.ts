/**
 * WebSocket Heartbeat (Ping/Pong)
 *
 * Server-initiated ping every 30 seconds.
 * If no pong is received within 10 seconds, the connection is terminated.
 */

import type { WebSocketServer, WebSocket } from 'ws';

const PING_INTERVAL_MS = 30_000; // 30 seconds
const PONG_TIMEOUT_MS = 10_000; // 10 seconds

/**
 * Extended WebSocket interface with heartbeat tracking properties.
 */
export interface HeartbeatWs extends WebSocket {
  isAlive: boolean;
  pongTimeoutTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Starts the heartbeat interval for the WebSocket server.
 * Sends a ping to all connected clients every 30 seconds.
 * If a client does not respond with pong within 10 seconds, it is terminated.
 *
 * @returns A cleanup function to stop the heartbeat interval
 */
export function startHeartbeat(wss: WebSocketServer): () => void {
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const heartbeatWs = ws as unknown as HeartbeatWs;

      if (heartbeatWs.isAlive === false) {
        // Previous ping was not answered - terminate
        heartbeatWs.terminate();
        return;
      }

      // Mark as not alive, send ping, and set a 10s timeout
      heartbeatWs.isAlive = false;
      heartbeatWs.ping();

      // Set a timeout: if no pong within 10s, terminate
      heartbeatWs.pongTimeoutTimer = setTimeout(() => {
        if (heartbeatWs.isAlive === false) {
          heartbeatWs.terminate();
        }
      }, PONG_TIMEOUT_MS);
    });
  }, PING_INTERVAL_MS);

  // Clean up when the WebSocket server closes
  wss.on('close', () => {
    clearInterval(interval);
  });

  return () => {
    clearInterval(interval);
  };
}

/**
 * Initializes heartbeat tracking on a newly connected WebSocket client.
 * Must be called when a new connection is established.
 */
export function initClientHeartbeat(ws: WebSocket): void {
  const heartbeatWs = ws as unknown as HeartbeatWs;
  heartbeatWs.isAlive = true;

  ws.on('pong', () => {
    heartbeatWs.isAlive = true;
    // Clear the pong timeout if it's still pending
    if (heartbeatWs.pongTimeoutTimer) {
      clearTimeout(heartbeatWs.pongTimeoutTimer);
      heartbeatWs.pongTimeoutTimer = undefined;
    }
  });
}
