import type http from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";

// Several WebSocket paths on one HTTP server need one `upgrade` listener that picks the server by
// path. Given `{ server, path }`, every WebSocketServer handles every upgrade and the ones whose
// path doesn't match answer it with HTTP 400, which kills a socket the matching one has just
// accepted (the client reads the 400 as a bad frame and closes with 1006). GAU-201.
/** Result of the pre-handshake check: refuse with an HTTP status, or allow and pass a value to the connection. */
export type UpgradeDecision<T> = { allow: true; context: T } | { allow: false; status: 401 | 403 };
export type UpgradeGuard<T> = (req: http.IncomingMessage) => Promise<UpgradeDecision<T>>;

export function routeUpgrades<T = undefined>(
  server: http.Server,
  routes: ReadonlyMap<string, WebSocketServer>,
  guard?: UpgradeGuard<T>,
): void {
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "/";
    const query = url.indexOf("?");
    const wss = routes.get(query === -1 ? url : url.slice(0, query));
    if (!wss) {
      reject(socket, 400, "Bad Request");
      return;
    }
    if (!guard) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    // Origin, session and role are checked BEFORE the handshake: a refused client never gets a
    // WebSocket (nothing to hold open, no frames parsed). The guard's context (the auth) is
    // passed as the third "connection" argument.
    socket.on("error", () => socket.destroy());
    guard(req).then(
      (decision) => {
        if (!decision.allow) {
          reject(socket, decision.status, decision.status === 401 ? "Unauthorized" : "Forbidden");
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, decision.context));
      },
      () => reject(socket, 401, "Unauthorized"),
    );
  });
}

/** Answer on the raw socket with a bodyless status (400 is what ws itself sends), then close. */
function reject(socket: Duplex, status: number, reason: string): void {
  socket.on("error", () => socket.destroy());
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
