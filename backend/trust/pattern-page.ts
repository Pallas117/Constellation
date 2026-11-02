/**
 * Asks a key's owner for its geometry pattern (GAU-67, key-lock.ts). On the Mac it opens a
 * one-time page with the rotating tesseract; over SSH, or with --pattern-tty, it reads the vertex
 * letters from the terminal without echoing them (or from piped stdin, for scripts and tests).
 *
 * The page listens on 127.0.0.1 only, on a random port, and closes after an accepted pattern,
 * five misses or three minutes. It answers only requests whose Host is its own address (against
 * DNS rebinding), takes a pattern only from its own origin with the nonce it put in the page, and
 * puts nothing secret in a URL. Each time it opens, the figure starts in a new orientation, so the
 * drawn shape differs while the vertices, and so the pattern, stay the same.
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { PATTERN_RULES, parsePatternLabels, patternProblem, VERTEX_LABELS, VERTICES, type PatternPrompt } from "./key-lock.js";

export type PatternMode = "unlock" | "lock";

export interface PatternPageOptions {
  mode: PatternMode;
  /** What the pattern is for, shown on the page: a key id or file name, never a secret. */
  label: string;
  maxMisses?: number;
  timeoutMs?: number;
  /** Shows the page to the owner; the default opens it in the Mac's browser. */
  open?: (url: string) => void;
}

export interface PatternPage {
  url: string;
  /** True once a pattern was accepted; false after too many misses or the timeout. */
  done: Promise<boolean>;
  close(): void;
}

const MAX_BODY = 4096;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

const isPattern = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length <= PATTERN_RULES.maxLength && v.every((x) => Number.isInteger(x) && x >= 0 && x < VERTICES);

/** Serve the one-time pattern page; `attempt` decides whether a pattern is accepted. */
export async function startPatternPage(attempt: (pattern: number[]) => boolean, options: PatternPageOptions): Promise<PatternPage> {
  const { mode, label } = options;
  const maxMisses = options.maxMisses ?? 5;
  const nonce = randomBytes(18).toString("base64url");
  const cspNonce = randomBytes(18).toString("base64url");
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${cspNonce}'`,
    `style-src 'nonce-${cspNonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  let misses = 0;
  let finished = false;
  let settle: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => (settle = resolve));

  const send = (res: ServerResponse, status: number, type: string, body: string, then?: () => void) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(type.startsWith("text/html") ? { "Content-Security-Policy": csp } : {}),
    });
    res.end(body, then);
  };
  const reply = (res: ServerResponse, body: object, then?: () => void) => send(res, 200, "application/json", JSON.stringify(body), then);

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const timer = setTimeout(() => finish(false), options.timeoutMs ?? 180_000);

  function finish(ok: boolean) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    settle(ok);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (finished) return send(res, 410, "text/plain", "closed");
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, "text/plain", "wrong host");
    if (req.method === "GET" && req.url === "/") return send(res, 200, "text/html; charset=utf-8", pageHtml(mode, label, nonce, cspNonce));
    if (req.method !== "POST" || req.url !== "/attempt") return send(res, 404, "text/plain", "not found");
    if (req.headers.origin !== origin) return send(res, 403, "text/plain", "wrong origin");
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, "text/plain", "send JSON");
    const text = await readBody(req);
    if (text === null) return send(res, 413, "text/plain", "too large");
    let body: { nonce?: unknown; pattern?: unknown; confirm?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return send(res, 400, "text/plain", "bad JSON");
    }
    const given = Buffer.from(typeof body.nonce === "string" ? body.nonce : "");
    const expected = Buffer.from(nonce);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(res, 403, "text/plain", "wrong nonce");
    if (!isPattern(body.pattern)) return reply(res, { ok: false, message: "That is not a pattern on this figure." });
    if (mode === "lock") {
      const problem = patternProblem(body.pattern);
      if (problem) return reply(res, { ok: false, message: `Choose another pattern: ${problem}.` });
      if (!isPattern(body.confirm) || body.confirm.join() !== body.pattern.join()) return reply(res, { ok: false, message: "The two patterns differ: start again." });
    }
    if (attempt(body.pattern)) return reply(res, { ok: true, done: true, message: mode === "lock" ? "Locked." : "Unlocked." }, () => finish(true));
    misses++;
    const left = maxMisses - misses;
    if (left <= 0) return reply(res, { ok: false, done: true, message: "Too many misses: this page is closed." }, () => finish(false));
    return reply(res, { ok: false, left, message: mode === "lock" ? "Not locked." : `No match. ${left} ${left === 1 ? "try" : "tries"} left.` });
  }

  const url = `${origin}/`;
  (options.open ?? openInBrowser)(url);
  return { url, done, close: () => finish(false) };
}

function openInBrowser(url: string) {
  console.error(`Draw the pattern in the page that opened (${url}); Ctrl-C to stop.`);
  execFile("open", [url], () => {});
}

/** Lines from the terminal, hidden as they are typed, or from piped stdin. */
function hiddenLines() {
  const stdin = process.stdin;
  const piped = stdin.isTTY ? null : createInterface({ input: stdin })[Symbol.asyncIterator]();
  return {
    async next(question: string): Promise<string | null> {
      process.stderr.write(question);
      if (piped) {
        const line = await piped.next();
        process.stderr.write("\n");
        return line.done ? null : line.value;
      }
      stdin.setRawMode(true);
      stdin.resume();
      return new Promise((resolve) => {
        let buf = "";
        const end = (value: string | null) => {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write("\n");
          resolve(value);
        };
        const onData = (d: Buffer) => {
          for (const ch of d.toString("utf8")) {
            if (ch === "\r" || ch === "\n") return end(buf);
            if (ch === "\u0003" || ch === "\u0004") return end(null);
            buf = ch === "\u007f" || ch === "\b" ? buf.slice(0, -1) : buf + ch;
          }
        };
        stdin.on("data", onData);
      });
    },
    close() {
      void piped?.return?.();
    },
  };
}

/** Read the pattern as vertex letters from the terminal. */
export function terminalPrompt(mode: PatternMode, label: string, maxMisses = 5): PatternPrompt {
  return async (attempt) => {
    const lines = hiddenLines();
    const letters = `${VERTEX_LABELS[0]} to ${VERTEX_LABELS[VERTICES - 1]}`;
    process.stderr.write(`${mode === "lock" ? "Choose" : "Enter"} the geometry pattern for ${label}: the vertex letters ${letters} in order (hidden as you type).\n`);
    try {
      for (let miss = 0; miss < maxMisses; miss++) {
        const text = await lines.next("pattern: ");
        if (text === null) return false;
        const pattern = parsePatternLabels(text);
        if (mode === "lock") {
          const problem = pattern ? patternProblem(pattern) : `use the letters ${letters} only`;
          if (problem) {
            process.stderr.write(`choose another pattern: ${problem}\n`);
            continue;
          }
          const again = await lines.next("again: ");
          if (again === null) return false;
          if (parsePatternLabels(again)?.join() !== pattern?.join()) {
            process.stderr.write("the two patterns differ\n");
            continue;
          }
        }
        if (pattern && attempt(pattern)) return true;
        process.stderr.write(mode === "lock" ? "not locked\n" : `no match (${maxMisses - miss - 1} left)\n`);
      }
      return false;
    } finally {
      lines.close();
    }
  };
}

/** The page on the Mac; the terminal over SSH, off macOS or when `terminal` is set. */
export function patternPrompt(mode: PatternMode, label: string, options: { terminal?: boolean } = {}): PatternPrompt {
  if (options.terminal || process.env.SSH_CONNECTION || process.platform !== "darwin" || !process.stdin.isTTY) return terminalPrompt(mode, label);
  return async (attempt) => (await startPatternPage(attempt, { mode, label })).done;
}

function pageHtml(mode: PatternMode, label: string, nonce: string, cspNonce: string): string {
  const config = JSON.stringify({ mode, nonce, labels: VERTEX_LABELS, rules: PATTERN_RULES });
  const title = mode === "lock" ? "Lock a signing key" : "Unlock a signing key";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gauss key ${mode}</title>
<style nonce="${cspNonce}">
:root { color-scheme: dark; --bg: #05070d; --ink: #e8e6df; --dim: #7d8696; --edge: rgba(120,200,230,.28); --gold: #e7b14a; --ok: #ccff00; --bad: #ff6b5e; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 16px; }
main { width: min(420px, 100%); text-align: center; }
h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; letter-spacing: .02em; }
p { margin: 4px 0; color: var(--dim); }
code { color: var(--ink); }
canvas { width: 100%; aspect-ratio: 1; touch-action: none; cursor: crosshair; display: block; margin: 12px 0; }
.row { display: flex; gap: 8px; justify-content: center; align-items: center; }
button { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--dim); border-radius: 6px; padding: 8px 16px; cursor: pointer; }
button.primary { border-color: var(--gold); color: var(--gold); }
button:disabled { opacity: .4; cursor: default; }
#msg { min-height: 1.5em; margin-top: 10px; color: var(--ink); }
#msg.bad { color: var(--bad); } #msg.ok { color: var(--ok); }
</style></head>
<body><main>
<h1>${title}</h1>
<p><code>${escapeHtml(label)}</code></p>
<p id="step">${mode === "lock" ? `Draw a new pattern: ${PATTERN_RULES.minLength} or more vertices, at least ${PATTERN_RULES.minDistinct} different.` : "Draw your pattern."}</p>
<canvas id="fig" width="400" height="400" aria-label="Rotating tesseract: click vertices in order, or type their letters"></canvas>
<p id="count" aria-live="polite">0 vertices</p>
<div class="row"><button id="clear" type="button">Clear</button><button id="go" class="primary" type="button">${mode === "lock" ? "Next" : "Unlock"}</button></div>
<p id="msg" role="status"></p>
</main>
<script nonce="${cspNonce}">
"use strict";
const C = ${config};
const V = [];
for (let x = -1; x <= 1; x += 2) for (let y = -1; y <= 1; y += 2) for (let z = -1; z <= 1; z += 2) for (let w = -1; w <= 1; w += 2) V.push([x, y, z, w]);
const E = [];
for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) if (V[i].filter((c, k) => c !== V[j][k]).length === 1) E.push([i, j]);
const rnd = () => Math.random() * Math.PI * 2;
const rot = { xy: rnd(), zw: rnd(), xz: rnd() };
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
const canvas = document.getElementById("fig"), ctx = canvas.getContext("2d");
const countEl = document.getElementById("count"), msg = document.getElementById("msg"), step = document.getElementById("step");
const go = document.getElementById("go"), clear = document.getElementById("clear");
let pattern = [], first = null, hovering = false, closed = false, busy = false, proj = [];
const dpr = Math.max(1, window.devicePixelRatio || 1);
canvas.width = canvas.height = 400 * dpr;
ctx.scale(dpr, dpr);
function project([x, y, z, w]) {
  let a = x * Math.cos(rot.xy) - y * Math.sin(rot.xy), b = x * Math.sin(rot.xy) + y * Math.cos(rot.xy); x = a; y = b;
  a = z * Math.cos(rot.zw) - w * Math.sin(rot.zw); b = z * Math.sin(rot.zw) + w * Math.cos(rot.zw); z = a; w = b;
  a = x * Math.cos(rot.xz) - z * Math.sin(rot.xz); b = x * Math.sin(rot.xz) + z * Math.cos(rot.xz); x = a; z = b;
  const f4 = 1 / (2.45 - w), f3 = 1 / (2.45 - z * f4);
  // The UI-UX-Gauss projection; 270 keeps every orientation inside the 400 px canvas (extent at most 0.671).
  return { x: x * f4 * f3 * 270 + 200, y: y * f4 * f3 * 270 + 200 };
}
function draw() {
  if (!hovering && !still && !closed) { rot.xy += 0.004; rot.zw += 0.003; rot.xz += 0.0015; }
  proj = V.map(project);
  ctx.clearRect(0, 0, 400, 400);
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(120,200,230,.28)";
  ctx.beginPath(); for (const [i, j] of E) { ctx.moveTo(proj[i].x, proj[i].y); ctx.lineTo(proj[j].x, proj[j].y); } ctx.stroke();
  if (pattern.length > 1) {
    ctx.strokeStyle = "#e7b14a"; ctx.lineWidth = 2; ctx.beginPath();
    pattern.forEach((v, n) => (n ? ctx.lineTo(proj[v].x, proj[v].y) : ctx.moveTo(proj[v].x, proj[v].y))); ctx.stroke();
  }
  ctx.font = "600 13px ui-monospace, monospace"; ctx.textAlign = "center";
  proj.forEach((p, i) => {
    const on = pattern.includes(i);
    ctx.beginPath(); ctx.arc(p.x, p.y, on ? 7 : 5, 0, Math.PI * 2); ctx.fillStyle = on ? "#e7b14a" : "#e8e6df"; ctx.fill();
    ctx.fillStyle = on ? "#e7b14a" : "#aab3c2"; ctx.fillText(C.labels[i], p.x, p.y - 11);
  });
  requestAnimationFrame(draw);
}
function show() { countEl.textContent = pattern.length + (pattern.length === 1 ? " vertex" : " vertices"); }
function add(i) { if (closed || busy || i < 0 || i >= V.length || pattern[pattern.length - 1] === i || pattern.length >= C.rules.maxLength) return; pattern.push(i); show(); if (msg.className === "bad") say(""); }
function say(text, kind) { msg.textContent = text; msg.className = kind || ""; }
canvas.addEventListener("pointerenter", () => (hovering = true));
canvas.addEventListener("pointerleave", () => (hovering = false));
canvas.addEventListener("pointerdown", (e) => {
  const r = canvas.getBoundingClientRect(), x = ((e.clientX - r.left) * 400) / r.width, y = ((e.clientY - r.top) * 400) / r.height;
  let best = -1, dist = 22;
  proj.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < dist) { dist = d; best = i; } });
  add(best);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Backspace") { pattern.pop(); show(); return; }
  if (e.key === "Enter") { go.click(); return; }
  const i = C.labels.indexOf(e.key.toUpperCase()); if (e.key.length === 1 && i >= 0) add(i);
});
clear.addEventListener("click", () => { pattern = []; show(); say(""); });
go.addEventListener("click", async () => {
  if (closed || busy) return;
  // A pattern this short can never match, so it is not sent and does not use up a try.
  if (pattern.length < C.rules.minLength) return say("Draw at least " + C.rules.minLength + " vertices.", "bad");
  if (C.mode === "lock" && first === null) {
    first = pattern; pattern = []; show(); step.textContent = "Draw the same pattern again."; go.textContent = "Lock"; return say("");
  }
  busy = true; go.disabled = true; say("Checking…");
  const body = C.mode === "lock" ? { nonce: C.nonce, pattern: first, confirm: pattern } : { nonce: C.nonce, pattern };
  try {
    const res = await fetch("/attempt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = res.ok ? await res.json() : { ok: false, message: "Refused (" + res.status + ")." };
    say(out.message, out.ok ? "ok" : "bad");
    if (out.done) { closed = true; clear.disabled = true; step.textContent = "You can close this tab."; return; }
  } catch { say("The signing tool has stopped.", "bad"); closed = true; return; }
  finally { busy = false; if (!closed) go.disabled = false; }
  pattern = []; show();
  if (C.mode === "lock") { first = null; step.textContent = "Draw a new pattern."; go.textContent = "Next"; }
});
show(); draw();
</script></body></html>`;
}
