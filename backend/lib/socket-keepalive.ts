import { WebSocket, type WebSocketServer } from "ws";

/**
 * Feed sockets that stop reading must not hold memory (GAU-208). A client that sleeps or drops off
 * the tailnet without closing leaves a half-open socket; every 5 s broadcast then queues ~1-2 KB for
 * it (20-35 MB a day) until TCP gives up, which on a half-open link may be never.
 */

/** Ping every 30 s; a socket that hasn't answered the previous ping is terminated. */
export const WS_HEARTBEAT_MS = 30_000;

/** Skip a broadcast for a socket with more than 1 MB still unsent (about 10 min of feed). */
export const WS_MAX_BUFFERED_BYTES = 1024 * 1024;

type LiveSocket = WebSocket & { isAlive?: boolean };

/** Mark each new socket alive, and alive again on every pong. */
export function trackLiveness(wss: WebSocketServer): void {
  wss.on("connection", (socket: LiveSocket) => {
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
  });
}

/** One heartbeat round: terminate sockets that missed the last ping, ping the rest. Returns the number terminated. */
export function sweepDeadSockets(wss: WebSocketServer): number {
  let terminated = 0;
  for (const client of wss.clients) {
    const socket = client as LiveSocket;
    if (socket.isAlive === false) {
      socket.terminate();
      terminated++;
      continue;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      // A socket closing mid-sweep throws; the next round terminates it.
    }
  }
  return terminated;
}

/** True when the socket is open and not backed up past the limit. */
export function canSend(socket: WebSocket, maxBuffered = WS_MAX_BUFFERED_BYTES): boolean {
  return socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= maxBuffered;
}
