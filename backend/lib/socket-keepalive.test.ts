import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket, type WebSocketServer } from "ws";
import { canSend, sweepDeadSockets, trackLiveness, WS_MAX_BUFFERED_BYTES } from "./socket-keepalive.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  pings = 0;
  terminated = false;
  isAlive?: boolean;
  ping() {
    this.pings++;
  }
  terminate() {
    this.terminated = true;
  }
}

function fakeServer() {
  const wss = new EventEmitter() as EventEmitter & { clients: Set<FakeSocket> };
  wss.clients = new Set();
  const connect = () => {
    const socket = new FakeSocket();
    wss.clients.add(socket);
    wss.emit("connection", socket);
    return socket;
  };
  return { wss: wss as unknown as WebSocketServer, connect };
}

test("socket keepalive: a socket that answers pings stays; one that stops is terminated on the next round", () => {
  const { wss, connect } = fakeServer();
  trackLiveness(wss);
  const answering = connect();
  const silent = connect();

  assert.equal(sweepDeadSockets(wss), 0, "first round only pings");
  assert.equal(answering.pings, 1);
  assert.equal(silent.pings, 1);

  answering.emit("pong");
  assert.equal(sweepDeadSockets(wss), 1);
  assert.equal(silent.terminated, true);
  assert.equal(answering.terminated, false);
  assert.equal(answering.pings, 2);
});

test("socket keepalive: a socket that throws on ping is terminated next round, not crashing the sweep", () => {
  const { wss, connect } = fakeServer();
  trackLiveness(wss);
  const closing = connect();
  closing.ping = () => {
    throw new Error("WebSocket is not open");
  };
  assert.equal(sweepDeadSockets(wss), 0);
  assert.equal(sweepDeadSockets(wss), 1);
  assert.equal(closing.terminated, true);
});

test("socket keepalive: sends are skipped for closed or backed-up sockets", () => {
  const socket = new FakeSocket() as unknown as WebSocket & FakeSocket;
  assert.equal(canSend(socket), true);
  socket.bufferedAmount = WS_MAX_BUFFERED_BYTES + 1;
  assert.equal(canSend(socket), false, "over 1 MB unsent");
  socket.bufferedAmount = 0;
  socket.readyState = WebSocket.CLOSING;
  assert.equal(canSend(socket), false);
});
