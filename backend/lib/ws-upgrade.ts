import type http from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";

// Several WebSocket paths on one HTTP server need one `upgrade` listener that picks the server by
// path. Given `{ server, path }`, every WebSocketServer handles every upgrade and the ones whose
// path doesn't match answer it with HTTP 400, which kills a socket the matching one has just
// accepted (the client reads the 400 as a bad frame and closes with 1006). GAU-201.
export function routeUpgrades(server: http.Server, routes: ReadonlyMap<string, WebSocketServer>): void {
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "/";
    const query = url.indexOf("?");
    const wss = routes.get(query === -1 ? url : url.slice(0, query));
    if (!wss) {
      reject(socket);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}

/** Unknown path: the same 400 ws itself sends, then close. */
function reject(socket: Duplex): void {
  socket.on("error", () => socket.destroy());
  socket.once("finish", () => socket.destroy());
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}
