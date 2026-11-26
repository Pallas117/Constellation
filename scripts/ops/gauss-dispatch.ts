/**
 * gauss-dispatch v0: route one task to local-coder (Mac), talos-coder (Talos over the existing SSH tunnel) or
 * cloud by written rules, log the choice, and keep a prompt-hash answer cache.
 *
 *   npm run dispatch -- "<task>" [file ...] [--route-only] [--sensitive] [--no-cache]
 *
 * Rules (first match wins, see RULES): SENSITIVE data (gauss-guard exit 3, or the guard cannot be run on the
 * given files) only ever goes to the Mac's local model and is never cached; then size in tokens; then task type
 * keywords. The cloud route only prints a recommendation: this script holds no API key and opens no listener.
 * It calls only loopback endpoints (local-coder 127.0.0.1:8089, OpenAI-style; talos-coder tunnel 127.0.0.1:11435,
 * Ollama with keep_alive 30m and num_ctx 8192).
 *
 * Log: one JSON line per call in <state dir>/dispatch.jsonl (route, rule, tokens, prompt sha256, cache result;
 * never the prompt text or file names). Cache: <state dir>/answer-cache.json, mode 0600, keyed by
 * sha256(model + system + prompt), with a TTL and an entry/byte cap. State dir: $GAUSS_DISPATCH_DIR, else
 * ~/Library/Application Support/Gauss/dispatch on macOS, else $XDG_STATE_HOME/gauss/dispatch.
 * Later step: move the cache into the memory service (gauss-brain, loopback) once v0 shows hits.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Route = "local-coder" | "talos-coder" | "cloud";
export type DataClass = "cloud-ok" | "sensitive" | "unknown";

export const SYSTEM_PROMPT =
  "You are a careful coding assistant for the Gauss repo. Answer briefly and exactly; say when you are unsure.";
/** Ollama context window; also the size limit for the local routes. */
export const NUM_CTX = 8192;
export const KEEP_ALIVE = "30m";
/** Measured 26 Nov 2026 on Qwen2.5-Coder prompts: about 3.36 bytes per token. */
export const BYTES_PER_TOKEN = 3.36;
/** Above this, Talos's first prompt pass takes minutes (3,200 tokens: 141 s vs 24 s on the Mac). */
export const TALOS_MAX_TOKENS = 1500;
/** Leave room for the answer inside num_ctx. */
export const LOCAL_MAX_TOKENS = NUM_CTX - 1024;

export const ENDPOINTS = {
  "local-coder": { url: "http://127.0.0.1:8089/v1/chat/completions", model: "mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit" },
  "talos-coder": { url: "http://127.0.0.1:11435/api/chat", model: "qwen2.5-coder:1.5b" },
} as const;

const HARD = /\b(design|architect\w*|security|threat|audit|review|plan|proof|prove|research|strategy|pitch|legal|requirement\w*)\b/i;
const CODE = /\b(fix|refactor|rename|lint|regex|test|tests|function|typo|format|snippet|sed|jq|bash|shell|sql|convert|explain)\b/i;

export interface RouteInput {
  text: string;
  tokens: number;
  dataClass: DataClass;
}
interface Rule {
  name: string;
  when: (i: RouteInput) => boolean;
  route: Route;
}

/** The written rules, in order. The first that matches decides. */
export const RULES: readonly Rule[] = [
  { name: "sensitive-local-only", when: (i) => i.dataClass === "sensitive", route: "local-coder" },
  { name: "guard-unknown-local-only", when: (i) => i.dataClass === "unknown", route: "local-coder" },
  { name: "too-large-for-local", when: (i) => i.tokens > LOCAL_MAX_TOKENS, route: "cloud" },
  { name: "hard-task-cloud", when: (i) => HARD.test(i.text), route: "cloud" },
  { name: "long-prompt-mac", when: (i) => i.tokens > TALOS_MAX_TOKENS, route: "local-coder" },
  { name: "small-code-talos", when: (i) => CODE.test(i.text), route: "talos-coder" },
  { name: "default-local", when: () => true, route: "local-coder" },
];

export function decideRoute(input: RouteInput): { route: Route; rule: string } {
  const rule = RULES.find((r) => r.when(input)) ?? RULES[RULES.length - 1];
  return { route: rule.route, rule: rule.name };
}

export const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const cacheKey = (model: string, system: string, prompt: string): string => sha256(`${model}\0${system}\0${prompt}`);

/** Run gauss-guard on the files: exit 0 = cloud-ok, 3 = sensitive, anything else (or no guard) = unknown. */
export function guardFiles(files: string[], guard = process.env.GAUSS_GUARD ?? join(homedir(), "gauss/bin/gauss-guard")): DataClass {
  if (files.length === 0) return "cloud-ok";
  if (!existsSync(guard)) return "unknown";
  const r = spawnSync(guard, files, { stdio: "ignore", timeout: 15_000 });
  return r.status === 0 ? "cloud-ok" : r.status === 3 ? "sensitive" : "unknown";
}

export function stateDir(env = process.env): string {
  if (env.GAUSS_DISPATCH_DIR) return env.GAUSS_DISPATCH_DIR;
  if (platform() === "darwin") return join(homedir(), "Library/Application Support/Gauss/dispatch");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "gauss/dispatch");
}

/** Only loopback endpoints may be called. */
export function assertLoopback(url: string): void {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) throw new Error(`refusing non-loopback endpoint ${host}`);
}

interface CacheEntry {
  t: number;
  answer: string;
}
export interface CacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
}
export const DEFAULT_CACHE: CacheOptions = { ttlMs: 7 * 24 * 3600_000, maxEntries: 500, maxBytes: 2_000_000 };

function writePrivate(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class AnswerCache {
  private readonly path: string;
  private readonly opts: CacheOptions;
  constructor(dir: string, opts: CacheOptions = DEFAULT_CACHE) {
    this.path = join(dir, "answer-cache.json");
    this.opts = opts;
  }
  private load(): Record<string, CacheEntry> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { entries?: Record<string, CacheEntry> };
      return parsed.entries ?? {};
    } catch {
      return {};
    }
  }
  get(key: string, now: number): string | undefined {
    const e = this.load()[key];
    return e && now - e.t <= this.opts.ttlMs ? e.answer : undefined;
  }
  set(key: string, answer: string, now: number): void {
    const live = Object.entries(this.load())
      .filter(([k, e]) => k !== key && now - e.t <= this.opts.ttlMs)
      .sort((a, b) => b[1].t - a[1].t);
    live.unshift([key, { t: now, answer }]);
    let kept = live.slice(0, this.opts.maxEntries);
    let body = JSON.stringify({ entries: Object.fromEntries(kept) });
    while (Buffer.byteLength(body) > this.opts.maxBytes && kept.length > 1) {
      kept = kept.slice(0, -1);
      body = JSON.stringify({ entries: Object.fromEntries(kept) });
    }
    if (Buffer.byteLength(body) > this.opts.maxBytes) return;
    writePrivate(this.path, body);
  }
}

export interface DispatchOptions {
  task: string;
  files?: string[];
  routeOnly?: boolean;
  forceSensitive?: boolean;
  noCache?: boolean;
}
export interface DispatchDeps {
  dir: string;
  fetch: typeof fetch;
  guard: (files: string[]) => DataClass;
  readFile: (path: string) => string;
  now: () => number;
  cache?: CacheOptions;
}
export interface DispatchResult {
  route: Route;
  rule: string;
  tokens: number;
  promptSha256: string;
  cache: "hit" | "miss" | "skip";
  answer?: string;
  recommendation?: string;
}

export function buildPrompt(task: string, files: string[], read: (p: string) => string): string {
  return [task, ...files.map((f, n) => `\n--- file ${n + 1} ---\n${read(f)}`)].join("\n");
}

async function ask(route: "local-coder" | "talos-coder", prompt: string, f: typeof fetch): Promise<string> {
  const ep = ENDPOINTS[route];
  assertLoopback(ep.url);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  const body =
    route === "talos-coder"
      ? { model: ep.model, stream: false, keep_alive: KEEP_ALIVE, options: { num_ctx: NUM_CTX, temperature: 0 }, messages }
      : { model: ep.model, max_tokens: 400, temperature: 0, stop: ["<|im_end|>"], messages };
  const res = await f(ep.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`${route} answered HTTP ${res.status}`);
  const json = (await res.json()) as { message?: { content?: string }; choices?: { message?: { content?: string } }[] };
  const text = route === "talos-coder" ? json.message?.content : json.choices?.[0]?.message?.content;
  return (text ?? "").replace("<|im_end|>", "").trim();
}

export async function dispatch(o: DispatchOptions, d: DispatchDeps): Promise<DispatchResult> {
  const files = o.files ?? [];
  const guarded = d.guard(files);
  const dataClass: DataClass = o.forceSensitive ? "sensitive" : guarded;
  // Files are read only after the guard ran; on the cloud route nothing is sent, so only the task is sized there.
  const prompt = buildPrompt(o.task, files, d.readFile);
  const tokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(prompt);
  const { route, rule } = decideRoute({ text: o.task, tokens, dataClass });
  const result: DispatchResult = { route, rule, tokens, promptSha256: sha256(prompt), cache: "skip" };
  const cacheable = dataClass === "cloud-ok" && !o.noCache;

  if (route === "cloud") {
    result.recommendation = `cloud (${rule}): run this in a Claude session; gauss-dispatch holds no API key.`;
  } else if (!o.routeOnly) {
    const model = ENDPOINTS[route].model;
    const key = cacheKey(model, SYSTEM_PROMPT, prompt);
    const cache = new AnswerCache(d.dir, d.cache);
    const hit = cacheable ? cache.get(key, d.now()) : undefined;
    if (hit !== undefined) {
      result.cache = "hit";
      result.answer = hit;
    } else {
      result.answer = await ask(route, prompt, d.fetch);
      if (cacheable) {
        result.cache = "miss";
        cache.set(key, result.answer, d.now());
      }
    }
  }

  const line = {
    ts: new Date(d.now()).toISOString(),
    route,
    rule,
    tokens,
    files: files.length,
    prompt_sha256: result.promptSha256,
    cache: result.cache,
  };
  appendFileSync(join(d.dir, "dispatch.jsonl"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  return result;
}

export function parseArgs(argv: string[]): DispatchOptions {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const rest = argv.filter((a) => !a.startsWith("--"));
  const known = ["--route-only", "--sensitive", "--no-cache"];
  for (const f of flags) if (!known.includes(f)) throw new Error(`unknown flag ${f}`);
  if (!rest[0]) throw new Error('usage: gauss-dispatch "<task>" [file ...] [--route-only] [--sensitive] [--no-cache]');
  return {
    task: rest[0],
    files: rest.slice(1),
    routeOnly: flags.has("--route-only"),
    forceSensitive: flags.has("--sensitive"),
    noCache: flags.has("--no-cache"),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const dir = stateDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const r = await dispatch(opts, {
      dir,
      fetch,
      guard: (f) => guardFiles(f),
      readFile: (p) => readFileSync(p, "utf8"),
      now: Date.now,
    });
    console.error(`route: ${r.route} (rule ${r.rule}, ~${r.tokens} tokens, cache ${r.cache})`);
    if (r.recommendation) console.log(r.recommendation);
    if (r.answer !== undefined) console.log(r.answer);
  } catch (error) {
    console.error(`gauss-dispatch: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
