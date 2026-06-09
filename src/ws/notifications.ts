/**
 * WebSocket Notification Broadcasting
 *
 * Provides utilities to push real-time notifications to connected
 * WebSocket clients. Notifications are delivered within 2 seconds
 * of the triggering event.
 */

import { WebSocket } from 'ws';
import type { WebSocketServer } from 'ws';

/**
 * Extended WebSocket with user context (set during upgrade authentication).
 */
export interface AuthenticatedWs extends WebSocket {
  userId: string;
  username: string;
  authenticated: boolean;
  connectedAt: number;
  isAlive: boolean;
}

/**
 * Notification payload structure sent over WebSocket.
 */
export interface WsNotificationPayload {
  type: string;
  notification?: {
    id: string;
    event_type: string;
    title: string | null;
    description: string;
    related_module: string;
    link: string;
    is_read: boolean;
    date: string;
    actor_id: string | null;
    entity_id: string | null;
    entity_type: string | null;
  };
  [key: string]: any;
}

/**
 * Broadcasts a notification payload to specific authenticated users.
 *
 * Delivery is immediate (synchronous send to each matching client),
 * ensuring notifications arrive within 2 seconds of the triggering event
 * when the client has an active WebSocket connection.
 *
 * @param wss - The WebSocketServer instance
 * @param targetUserIds - Array of user IDs to receive the notification
 * @param payload - The notification payload object to send
 */
export function broadcastToUsers(
  wss: WebSocketServer,
  targetUserIds: string[],
  payload: WsNotificationPayload
): void {
  if (!targetUserIds.length) return;

  const message = JSON.stringify(payload);

  wss.clients.forEach((client) => {
    const ws = client as unknown as AuthenticatedWs;
    if (
      ws.readyState === WebSocket.OPEN &&
      ws.authenticated &&
      targetUserIds.includes(ws.userId)
    ) {
      ws.send(message);
    }
  });
}

/**
 * Broadcasts a message to ALL authenticated and connected clients.
 *
 * @param wss - The WebSocketServer instance
 * @param payload - The payload object to send
 */
export function broadcastToAll(
  wss: WebSocketServer,
  payload: WsNotificationPayload
): void {
  const message = JSON.stringify(payload);

  wss.clients.forEach((client) => {
    const ws = client as unknown as AuthenticatedWs;
    if (ws.readyState === WebSocket.OPEN && ws.authenticated) {
      ws.send(message);
    }
  });
}

/**
 * Gets the count of currently connected authenticated clients.
 */
export function getConnectedClientCount(wss: WebSocketServer): number {
  let count = 0;
  wss.clients.forEach((client) => {
    const ws = client as unknown as AuthenticatedWs;
    if (ws.readyState === WebSocket.OPEN && ws.authenticated) {
      count++;
    }
  });
  return count;
}
