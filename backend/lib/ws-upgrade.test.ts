import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { routeUpgrades } from "./ws-upgrade.js";

type Probe = { opened: boolean; messages: string[]; status: number | null; closeCode: number | null; openAfter: boolean };

/**
 * Connect, wait until the connection is decided (open, refused or failed), hold it for `holdMs`,
 * and report what happened; a 400 shows up as `status`.
 *
 * The hold starts when the outcome is known, not when the probe starts: on a loaded machine the
 * handshake alone can take longer than a fixed hold (seen in the gate run of 2026-11-10, "a opened"
 * false after 150 ms), which says nothing about the routing under test.
 */
function probe(url: string, holdMs = 150, connectDeadlineMs = 5_000): Promise<Probe> {
  return new Promise((resolve) => {
    const result: Probe = { opened: false, messages: [], status: null, closeCode: null, openAfter: false };
    const ws = new WebSocket(url);
    let holding = false;
    const hold = () => {
      if (holding) return;
      holding = true;
      clearTimeout(deadline);
      setTimeout(() => {
        // Snapshot before terminate(): our own close (1006) must not land in the result while
        // Promise.all still waits for the other probe, which happens when the timers fire apart.
        const seen: Probe = { ...result, messages: [...result.messages], openAfter: ws.readyState === WebSocket.OPEN };
        ws.terminate();
        resolve(seen);
      }, holdMs);
    };
    const deadline = setTimeout(hold, connectDeadlineMs);
    ws.on("open", () => {
      result.opened = true;
      hold();
    });
    ws.on("message", (data) => result.messages.push(String(data)));
    ws.on("unexpected-response", (_req, res) => {
      result.status = res.statusCode ?? null;
      res.resume();
      ws.terminate();
      hold();
    });
    ws.on("error", hold);
    ws.on("close", (code) => (result.closeCode = code));
  });
}

async function twoServers(t: test.TestContext) {
  const server = http.createServer();
  const a = new WebSocketServer({ noServer: true });
  const b = new WebSocketServer({ noServer: true });
  a.on("connection", (socket) => socket.send("a"));
  b.on("connection", (socket) => socket.send("b"));
  routeUpgrades(server, new Map([["/a", a], ["/b", b]]));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    a.close();
    b.close();
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as { port: number };
  return { base: `ws://127.0.0.1:${port}`, a, b };
}

test("ws upgrades: two paths on one server both connect at once and stay open (GAU-201)", async (t) => {
  const { base } = await twoServers(t);
  const [onA, onB] = await Promise.all([probe(`${base}/a`), probe(`${base}/b`)]);
  for (const [name, p] of [["a", onA], ["b", onB]] as const) {
    assert.equal(p.opened, true, `${name} opened`);
    assert.deepEqual(p.messages, [name], `${name} got only its own server's message`);
    assert.equal(p.openAfter, true, `${name} still open`);
    assert.equal(p.closeCode, null, `${name} not closed by the other server`);
  }
});

test("ws upgrades: a query string still routes by path", async (t) => {
  const { base } = await twoServers(t);
  const p = await probe(`${base}/b?since=2026-10-24T00:00:00Z`);
  assert.equal(p.opened, true);
  assert.deepEqual(p.messages, ["b"]);
});

test("ws upgrades: an unknown path gets 400 and no socket", async (t) => {
  const { base, a, b } = await twoServers(t);
  for (const path of ["/c", "/a/extra", "/", "/__proto__"]) {
    const p = await probe(`${base}${path}`);
    assert.equal(p.status, 400, path);
    assert.equal(p.opened, false, path);
  }
  assert.equal(a.clients.size, 0);
  assert.equal(b.clients.size, 0);
});
