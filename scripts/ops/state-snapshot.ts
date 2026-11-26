/**
 * State snapshot v0: a read-only, fixed-shape JSON view of ops state (node x zone x metric).
 *
 *   node scripts/ops/state-snapshot.ts [--pretty] [--out <file>]
 *
 * Every cell is {value, mask, age_s, source}. mask 1 = measured and fresh; mask 0 = missing,
 * not measured or older than the metric's max age, and then value is null (never a made-up 0).
 * Inputs (all local, read-only): Argo's state.json and incidents.jsonl, the gates runner's
 * results.log, and the memory service status on loopback if it answers. No listener, no network
 * beyond 127.0.0.1, no writes except stdout or the explicit --out file.
 *
 * Node ids are generic (node-0..node-7). Which node is this Mac and which runs the gates comes from
 * a local file outside the repo (default ~/.config/gauss/state-snapshot.json, or
 * GAUSS_STATE_SNAPSHOT_CONFIG): {"nodes": ["node-0", "node-1"], "local": "node-0", "gatebox": "node-1"}.
 * Without it there is one node, node-0, holding every source. Runs with Node 26 type stripping.
 */
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA = "gauss-state-snapshot/v0";
export const ZONES = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export const MAX_NODES = 8;
export type Zone = (typeof ZONES)[number];
export type Source = "argo" | "gates" | "memory";

export interface Cell {
  value: number | null;
  mask: 0 | 1;
  age_s: number | null;
  source: Source;
}

interface MetricDef {
  zone: Zone;
  source: Source;
  maxAgeS: number;
}

/** The fixed metric catalogue. Zones without a metric yet keep an empty object, so the shape never changes. */
export const METRICS: Record<string, MetricDef> = {
  // A: operator vault / memory service
  mem_up: { zone: "A", source: "memory", maxAgeS: 60 },
  mem_documents: { zone: "A", source: "memory", maxAgeS: 60 },
  mem_index_age_s: { zone: "A", source: "memory", maxAgeS: 60 },
  // F: mesh and links (Argo)
  net_ok: { zone: "F", source: "argo", maxAgeS: 900 },
  net_rtt_ms: { zone: "F", source: "argo", maxAgeS: 900 },
  net_loss_pct: { zone: "F", source: "argo", maxAgeS: 900 },
  net_jitter_ms: { zone: "F", source: "argo", maxAgeS: 900 },
  net_privacy: { zone: "F", source: "argo", maxAgeS: 900 },
  tailnet_ms: { zone: "F", source: "argo", maxAgeS: 900 },
  outages_24h: { zone: "F", source: "argo", maxAgeS: 900 },
  // H: validate step of the loop (merge-train gates)
  gate_last_ok: { zone: "H", source: "gates", maxAgeS: 3 * 86400 },
  gate_last_s: { zone: "H", source: "gates", maxAgeS: 3 * 86400 },
  gate_runs_24h: { zone: "H", source: "gates", maxAgeS: 3 * 86400 },
};

/** A raw reading: the value and when it was measured (ms since epoch). null value = not measured. */
export type Reading = { value: number | null; at: number | null };
export type Readings = Partial<Record<string, Reading>>;

export interface NodeConfig {
  nodes: string[];
  local: string;
  gatebox: string;
}

export const DEFAULT_CONFIG: NodeConfig = { nodes: ["node-0"], local: "node-0", gatebox: "node-0" };

/** Accepts only generic ids (node-N), at most MAX_NODES; anything else falls back to the default. */
export function parseConfig(raw: unknown): NodeConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && /^node-\d{1,2}$/.test(v);
  const nodes = Array.isArray(r.nodes) ? r.nodes.filter(ok) : [];
  const unique = [...new Set(nodes)].slice(0, MAX_NODES);
  if (unique.length === 0) return DEFAULT_CONFIG;
  const pick = (v: unknown) => (ok(v) && unique.includes(v) ? v : unique[0]);
  return { nodes: unique, local: pick(r.local), gatebox: pick(r.gatebox) };
}

function cell(def: MetricDef, r: Reading | undefined, now: number): Cell {
  if (!r || r.value === null || !Number.isFinite(r.value) || r.at === null) {
    return { value: null, mask: 0, age_s: null, source: def.source };
  }
  const age = Math.max(0, Math.round((now - r.at) / 1000));
  if (age > def.maxAgeS) return { value: null, mask: 0, age_s: age, source: def.source };
  return { value: r.value, mask: 1, age_s: age, source: def.source };
}

export interface Snapshot {
  schema: string;
  generated_at: string;
  dims: { nodes: string[]; zones: readonly Zone[]; metrics: Record<Zone, string[]> };
  cells: Record<string, Record<Zone, Record<string, Cell>>>;
}

/** Pure: same inputs, same output. Each source's readings land on the node that owns that source. */
export function buildSnapshot(readings: Readings, config: NodeConfig, now: number): Snapshot {
  const metrics = Object.fromEntries(ZONES.map((z) => [z, [] as string[]])) as Record<Zone, string[]>;
  for (const [name, def] of Object.entries(METRICS)) metrics[def.zone].push(name);
  const owner: Record<Source, string> = { argo: config.local, memory: config.local, gates: config.gatebox };
  const cells: Snapshot["cells"] = {};
  for (const node of config.nodes) {
    const zones = {} as Record<Zone, Record<string, Cell>>;
    for (const z of ZONES) {
      zones[z] = {};
      for (const name of metrics[z]) {
        const def = METRICS[name];
        zones[z][name] = cell(def, owner[def.source] === node ? readings[name] : undefined, now);
      }
    }
    cells[node] = zones;
  }
  return { schema: SCHEMA, generated_at: new Date(now).toISOString(), dims: { nodes: config.nodes, zones: ZONES, metrics }, cells };
}

// ---- readers (local files and loopback only) ----

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Argo writes -1 for "not measured". */
const measured = (v: unknown): number | null => {
  const n = num(v);
  return n === null || n < 0 ? null : n;
};

function readTail(path: string, maxBytes: number): string | null {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const text = buf.toString("utf8");
      return size > len ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Argo state.json + incidents.jsonl (tools/argo store.go, netscore.go, radio.go). */
export function readArgo(dir: string, now: number): Readings {
  let st: Obj;
  try {
    st = obj(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")));
  } catch {
    return {};
  }
  const at = typeof st.checked_at === "string" ? Date.parse(st.checked_at) : NaN;
  if (!Number.isFinite(at)) return {};
  const net = obj(st.net);
  const link = obj(net.link);
  const tail = obj(obj(st.switch).tailnet);
  const r = (value: number | null): Reading => ({ value, at });
  const out: Readings = {
    net_ok: r(typeof st.class === "string" ? (st.class === "OK" ? 1 : 0) : null),
    net_rtt_ms: r(measured(link.net_rtt_ms) ?? measured(net.rtt_ms)),
    net_loss_pct: r(measured(link.net_loss_pct)),
    net_jitter_ms: r(measured(link.net_jitter_ms)),
    net_privacy: r(measured(net.privacy)),
    // Answered() in tailnet.go: ms >= 0 and a peer was asked; the check has its own time (the last switch).
    tailnet_ms: {
      value: typeof tail.peer === "string" && tail.peer !== "" ? measured(tail.ms) : null,
      at: typeof tail.at === "string" && Number.isFinite(Date.parse(tail.at)) ? Date.parse(tail.at) : null,
    },
  };
  const log = readTail(join(dir, "incidents.jsonl"), 512 * 1024);
  if (log !== null) {
    let opens = 0;
    for (const line of log.split("\n")) {
      if (!line.includes('"open"')) continue;
      try {
        const e = obj(JSON.parse(line));
        const t = typeof e.time === "string" ? Date.parse(e.time) : NaN;
        if (e.event === "open" && t <= now && now - t <= 86400_000) opens++;
      } catch {
        /* a torn line is skipped */
      }
    }
    out.outages_24h = r(opens);
  }
  return out;
}

/** Gates runner results.log: "<iso> <sha> <tree> <VERB> <text>"; FAILED lines carry "in N s". */
export function readGates(path: string, now: number): Readings {
  const log = readTail(path, 256 * 1024);
  if (log === null) return {};
  let fileAt: number;
  try {
    fileAt = statSync(path).mtimeMs;
  } catch {
    return {};
  }
  const out: Readings = {};
  let runs = 0;
  for (const line of log.split("\n")) {
    const m = /^(\S+) \S+ \S+ (PASSED|FAILED|ERROR) (.*)$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    if (now - t <= 86400_000 && t <= now) runs++;
    out.gate_last_ok = { value: m[2] === "PASSED" ? 1 : 0, at: t };
    const d = / in (\d+) s\b/.exec(m[3]);
    if (d) out.gate_last_s = { value: Number(d[1]), at: t };
  }
  out.gate_runs_24h = { value: runs, at: Math.min(now, fileAt) };
  return out;
}

/** Loopback only: anything else is refused, so the snapshot never calls out. */
export function loopbackUrl(raw: string | undefined): string | null {
  try {
    const u = new URL(raw ?? "http://127.0.0.1:3002");
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Memory service /api/rag/status (counts and freshness only, as backend/memory/client.ts). */
export async function readMemory(base: string | null, now: number): Promise<Readings> {
  if (!base) return {};
  try {
    const res = await fetch(`${base}/api/rag/status`, { signal: AbortSignal.timeout(2000), redirect: "error" });
    if (!res.ok) return { mem_up: { value: 0, at: now } };
    const b = (await res.json()) as Record<string, unknown>;
    const idx = typeof b.lastIndexAt === "string" ? Date.parse(b.lastIndexAt) : NaN;
    return {
      mem_up: { value: 1, at: now },
      mem_documents: { value: measured(b.documents), at: now },
      mem_index_age_s: { value: Number.isFinite(idx) ? Math.max(0, Math.round((now - idx) / 1000)) : null, at: now },
    };
  } catch {
    return { mem_up: { value: 0, at: now } };
  }
}

function loadConfig(path: string): NodeConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function main(argv: string[]): Promise<void> {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const home = homedir();
  const now = Date.now();
  const config = loadConfig(process.env.GAUSS_STATE_SNAPSHOT_CONFIG ?? join(home, ".config/gauss/state-snapshot.json"));
  const readings: Readings = {
    ...readArgo(flag("--argo-dir") ?? join(home, ".local/state/argo"), now),
    ...readGates(flag("--gates-log") ?? join(home, "Library/Application Support/Gauss/gates/results.log"), now),
    ...(await readMemory(loopbackUrl(process.env.GAUSS_MEMORY_URL), now)),
  };
  const snap = buildSnapshot(readings, config, now);
  const text = JSON.stringify(snap, null, argv.includes("--pretty") ? 1 : undefined) + "\n";
  const out = flag("--out");
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
