import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnswerCache,
  KEEP_ALIVE,
  LOCAL_MAX_TOKENS,
  NUM_CTX,
  TALOS_MAX_TOKENS,
  assertLoopback,
  decideRoute,
  dispatch,
  parseArgs,
  type DataClass,
  type DispatchDeps,
} from "./gauss-dispatch";

const SECRET_TASK = "fix the regex in the zebra-quokka parser";

function deps(dataClass: DataClass, calls: { url: string; body: Record<string, unknown> }[]): DispatchDeps {
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    const payload = String(url).includes("/api/chat")
      ? { message: { content: "talos answer" } }
      : { choices: [{ message: { content: "mac answer<|im_end|>" } }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return {
    dir: mkdtempSync(join(tmpdir(), "gauss-dispatch-")),
    fetch: fakeFetch,
    guard: () => dataClass,
    readFile: () => "file body",
    now: () => 1_800_000_000_000,
  };
}

test("dispatch rule table: first matching written rule decides", () => {
  const rows: [string, number, DataClass, string, string][] = [
    ["design the zone map", 100, "sensitive", "local-coder", "sensitive-local-only"],
    ["design the zone map", LOCAL_MAX_TOKENS + 1, "sensitive", "local-coder", "sensitive-local-only"],
    ["fix a typo", 100, "unknown", "local-coder", "guard-unknown-local-only"],
    ["fix a typo", LOCAL_MAX_TOKENS + 1, "cloud-ok", "cloud", "too-large-for-local"],
    ["review the security plan", 100, "cloud-ok", "cloud", "hard-task-cloud"],
    ["fix a typo", TALOS_MAX_TOKENS + 1, "cloud-ok", "local-coder", "long-prompt-mac"],
    ["fix a typo in this function", 200, "cloud-ok", "talos-coder", "small-code-talos"],
    ["summarise these notes", 200, "cloud-ok", "local-coder", "default-local"],
  ];
  for (const [text, tokens, dataClass, route, rule] of rows) {
    assert.deepEqual(decideRoute({ text, tokens, dataClass }), { route, rule }, `${text} / ${tokens} / ${dataClass}`);
  }
});

test("dispatch keeps SENSITIVE data on the Mac model and never caches it", async () => {
  for (const task of ["design the threat model", "fix a typo in this function"]) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const d = deps("sensitive", calls);
    const a = await dispatch({ task, files: ["notes.md"] }, d);
    const b = await dispatch({ task, files: ["notes.md"] }, d);
    assert.equal(a.route, "local-coder");
    assert.equal(a.rule, "sensitive-local-only");
    assert.equal(a.cache, "skip");
    assert.equal(b.cache, "skip");
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.url.startsWith("http://127.0.0.1:8089/")));
    assert.throws(() => statSync(join(d.dir, "answer-cache.json")));
  }
  const forced = await dispatch({ task: "fix a typo in this function", forceSensitive: true }, deps("cloud-ok", []));
  assert.equal(forced.route, "local-coder");
});

test("dispatch: a second identical ask is a cache hit from a 0600 file", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const d = deps("cloud-ok", calls);
  const first = await dispatch({ task: SECRET_TASK }, d);
  const second = await dispatch({ task: SECRET_TASK }, d);
  assert.equal(first.route, "talos-coder");
  assert.equal(first.cache, "miss");
  assert.equal(second.cache, "hit");
  assert.equal(second.answer, "talos answer");
  assert.equal(calls.length, 1);
  assert.equal(statSync(join(d.dir, "answer-cache.json")).mode & 0o777, 0o600);
  // Ollama gets keep_alive and num_ctx on every request.
  assert.equal(calls[0].url, "http://127.0.0.1:11435/api/chat");
  assert.equal(calls[0].body.keep_alive, KEEP_ALIVE);
  assert.deepEqual((calls[0].body.options as { num_ctx: number }).num_ctx, NUM_CTX);
});

test("dispatch log has route, rule and prompt hash but no prompt text", async () => {
  const d = deps("cloud-ok", []);
  await dispatch({ task: SECRET_TASK, files: ["private-name.md"] }, d);
  const cloud = await dispatch({ task: "review the security plan for zebra-quokka" }, d);
  assert.equal(cloud.route, "cloud");
  assert.equal(cloud.answer, undefined);
  const log = readFileSync(join(d.dir, "dispatch.jsonl"), "utf8");
  const lines = log.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 2);
  assert.match(String(lines[0].prompt_sha256), /^[0-9a-f]{64}$/);
  assert.equal(lines[0].rule, "small-code-talos");
  assert.equal(lines[1].route, "cloud");
  assert.doesNotMatch(log, /zebra|quokka|regex|private-name|file body/);
  assert.equal(statSync(join(d.dir, "dispatch.jsonl")).mode & 0o777, 0o600);
});

test("dispatch cache honours TTL and size cap; endpoints stay on loopback", () => {
  const dir = mkdtempSync(join(tmpdir(), "gauss-dispatch-"));
  const cache = new AnswerCache(dir, { ttlMs: 1000, maxEntries: 2, maxBytes: 10_000 });
  cache.set("a", "1", 0);
  cache.set("b", "2", 10);
  cache.set("c", "3", 20);
  assert.equal(cache.get("a", 20), undefined);
  assert.equal(cache.get("c", 20), "3");
  assert.equal(cache.get("c", 2000), undefined);
  assert.throws(() => assertLoopback("http://talos.example:11435/api/chat"));
  assert.doesNotThrow(() => assertLoopback("http://127.0.0.1:11435/api/chat"));
  assert.throws(() => parseArgs(["--bogus", "x"]));
  assert.deepEqual(parseArgs(["task", "a.md", "--route-only"]).files, ["a.md"]);
});
