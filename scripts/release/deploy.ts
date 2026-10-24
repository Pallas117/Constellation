/**
 * Verified-tag-only deploys with a health check and automatic rollback (GAU-123).
 * NASA SP-2016-6105 Rev 2 §6.5 configuration management, §5.5 transition.
 *
 *   npm run deploy -- v1.2.3 [--checkout PATH] [--dry-run]
 *   npm run rollback -- [--checkout PATH]
 *
 * The checkout defaults to $GAUSS_LIVE_CHECKOUT. Commands can be overridden for tests or other hosts:
 *   GAUSS_INSTALL_CMD  (default: npm ci)
 *   GAUSS_RESTART_CMD  (default: bash scripts/ops/gauss-services.sh restart)
 *   GAUSS_HEALTH_CMD   (default: npm run --silent tpm). Exit 0/1 healthy (green/amber); 2 red or 3 unreachable fail.
 *   GAUSS_HEALTH_WAIT_MS (default 20000) before the health check.
 *   GAUSS_EVENTS_LOG   (default ~/Library/Logs/gauss/events.jsonl): deploy/rollback events in the
 *                      same format as scripts/ops/gauss-services.sh's event() (GAU-164).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DeployOptions {
  checkout: string;
  installCmd: string;
  restartCmd: string;
  healthCmd: string;
  healthWaitMs: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
  /** events.jsonl to append deploy/rollback events to; none when unset (tests). */
  eventsLog?: string;
}

export interface HistoryEntry {
  action: "deploy" | "rollback" | "auto-rollback";
  ref: string;
  commit: string;
  from: string;
  at: string;
  result: "ok" | "failed";
}

export function defaultOptions(checkout: string): DeployOptions {
  return {
    checkout,
    installCmd: process.env.GAUSS_INSTALL_CMD ?? "npm ci",
    restartCmd: process.env.GAUSS_RESTART_CMD ?? "bash scripts/ops/gauss-services.sh restart",
    healthCmd: process.env.GAUSS_HEALTH_CMD ?? "npm run --silent tpm",
    healthWaitMs: Number(process.env.GAUSS_HEALTH_WAIT_MS ?? 20_000),
    eventsLog: process.env.GAUSS_EVENTS_LOG ?? path.join(os.homedir(), "Library/Logs/gauss/events.jsonl"),
  };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const gitOk = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd }).status === 0;
const sh = (cwd: string, cmd: string) => spawnSync("sh", ["-c", cmd], { cwd, stdio: "inherit" }).status ?? 1;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function historyPath(checkout: string): string {
  // Inside .git: per-checkout, never committed.
  return path.join(git(checkout, "rev-parse", "--absolute-git-dir"), "gauss-deploy-history.jsonl");
}

export function readHistory(checkout: string): HistoryEntry[] {
  const p = historyPath(checkout);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as HistoryEntry);
}

function record(o: DeployOptions, e: HistoryEntry) {
  appendFileSync(historyPath(o.checkout), JSON.stringify(e) + "\n");
  if (!o.eventsLog) return;
  const event = e.action === "deploy" ? "deploy" : "rollback";
  appendEvent(o.eventsLog, o.checkout, {
    event, label: e.ref, reason: `${e.action} ${e.from} -> ${e.ref}: ${e.result}`,
    from: e.from, to: e.commit, result: e.result, via: "npm run deploy",
  });
}

const out = (cmd: string, ...args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5_000 });
  return r.status === 0 ? r.stdout : "";
};
const int = (s: string | undefined) => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : null);
/** Same rule as the shell's redact(): no credentials in URLs, query strings or key=/token= values in a log. */
export const redact = (s: string) =>
  s.replace(/(:\/\/)[^/@ ]+@/g, "$1")
    .replace(/(https?:\/\/[^ ?"]*)\?[^ "]*/g, "$1?<redacted>")
    .replace(/([A-Za-z_]*(token|secret|password|key))=[^ &"]+/gi, "$1=<redacted>");

export interface OpsEvent {
  event: "deploy" | "rollback";
  label: string;
  reason: string;
  [extra: string]: string | number | boolean | null;
}

/** Append one line to events.jsonl in gauss-services.sh's format; never throws (a log must not fail a deploy). */
export function appendEvent(file: string, checkout: string, e: OpsEvent, maxKb = Number(process.env.GAUSS_EVENTS_MAX_KB ?? 5120)) {
  try {
    const live = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
    const ready = path.join(os.homedir(), "Library/Application Support/Gauss/fallback/ready");
    const fb = existsSync(ready) ? readFileSync(ready, "utf8").split(" ")[0] : "";
    const batt = out("pmset", "-g", "batt");
    const swap = /used = ([\d.]+)M/.exec(out("sysctl", "-n", "vm.swapusage"))?.[1];
    const fields: Record<string, unknown> = {
      ts: new Date().toISOString().slice(0, 19) + "Z",
      host: os.hostname().split(".")[0],
      event: e.event, label: e.label, reason: redact(e.reason),
      live_sha: live.status === 0 ? live.stdout.trim() : null,
      fallback_sha: /^[0-9a-f]{7,40}$/.test(fb) ? fb : null,
      pressure: int(out("sysctl", "-n", "kern.memorystatus_vm_pressure_level").trim()),
      swap_mb: swap ? Math.trunc(Number(swap)) : null,
      battery: int(/(\d+)%/.exec(batt)?.[1]),
      on_ac: batt.includes("'AC Power'"),
    };
    for (const [k, v] of Object.entries(e)) if (!(k in fields)) fields[k] = typeof v === "string" ? redact(v) : v;
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size >= maxKb * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, JSON.stringify(fields) + "\n");
  } catch {
    /* best effort */
  }
}

/** Reasons a tag may not be deployed to this checkout; empty when it may. */
export function preflight(o: DeployOptions, tag: string): string[] {
  const problems: string[] = [];
  if (!/^v\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(tag)) problems.push(`not a release tag: ${tag}`);
  if (!gitOk(o.checkout, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`)) {
    problems.push(`tag ${tag} not found (fetch tags first)`);
    return problems;
  }
  const commit = git(o.checkout, "rev-parse", `${tag}^{commit}`);
  if (!gitOk(o.checkout, "merge-base", "--is-ancestor", commit, "origin/main")) problems.push(`${tag} is not on origin/main`);
  const notes = git(o.checkout, "tag", "-l", "--format=%(contents)", tag);
  if (!/VERIFY PASSED at/.test(notes)) problems.push(`${tag} carries no verify evidence (tag with scripts/release/create-tag.sh)`);
  if (git(o.checkout, "status", "--porcelain", "--untracked-files=no")) problems.push("live checkout has local changes");
  return problems;
}

/** Switch the checkout to `ref`, install, restart, wait, health-check. True when healthy. */
function activate(o: DeployOptions, ref: string): boolean {
  const log = o.log ?? console.log;
  git(o.checkout, "checkout", "--quiet", "--detach", ref);
  if (sh(o.checkout, o.installCmd) !== 0) return (log(`install failed at ${ref}`), false);
  if (sh(o.checkout, o.restartCmd) !== 0) return (log(`restart failed at ${ref}`), false);
  if (o.healthWaitMs > 0) sleep(o.healthWaitMs);
  const health = sh(o.checkout, o.healthCmd);
  log(`health check at ${ref}: exit ${health}`);
  return health === 0 || health === 1; // green/insufficient or amber
}

function currentRef(checkout: string): { ref: string; commit: string } {
  const commit = git(checkout, "rev-parse", "HEAD");
  const tag = spawnSync("git", ["describe", "--tags", "--exact-match", "HEAD"], { cwd: checkout, encoding: "utf8" });
  return { ref: tag.status === 0 ? tag.stdout.trim() : commit, commit };
}

export function deploy(o: DeployOptions, tag: string): { ok: boolean; problems: string[] } {
  const log = o.log ?? console.log;
  spawnSync("git", ["fetch", "--quiet", "--tags", "origin"], { cwd: o.checkout });
  const problems = preflight(o, tag);
  if (problems.length) return { ok: false, problems };
  const from = currentRef(o.checkout);
  if (o.dryRun) {
    log(`dry run: would deploy ${tag} (from ${from.ref}) in ${o.checkout}`);
    return { ok: true, problems: [] };
  }
  const commit = git(o.checkout, "rev-parse", `${tag}^{commit}`);
  const healthy = activate(o, tag);
  record(o, { action: "deploy", ref: tag, commit, from: from.ref, at: new Date().toISOString(), result: healthy ? "ok" : "failed" });
  if (healthy) {
    log(`deployed ${tag}`);
    return { ok: true, problems: [] };
  }
  log(`${tag} unhealthy: rolling back to ${from.ref}`);
  const back = activate(o, from.commit);
  record(o, { action: "auto-rollback", ref: from.ref, commit: from.commit, from: tag, at: new Date().toISOString(), result: back ? "ok" : "failed" });
  return { ok: false, problems: [`${tag} failed its health check; rolled back to ${from.ref}${back ? "" : " (rollback ALSO unhealthy)"}`] };
}

/** Return to the release deployed before the current one. */
export function rollback(o: DeployOptions): { ok: boolean; problems: string[] } {
  const log = o.log ?? console.log;
  const now = currentRef(o.checkout);
  const good = readHistory(o.checkout).filter((e) => e.action === "deploy" && e.result === "ok" && e.commit !== now.commit);
  const target = good[good.length - 1];
  if (!target) return { ok: false, problems: ["no earlier healthy deploy in history"] };
  if (o.dryRun) {
    log(`dry run: would roll back ${now.ref} → ${target.ref}`);
    return { ok: true, problems: [] };
  }
  const healthy = activate(o, target.commit);
  record(o, { action: "rollback", ref: target.ref, commit: target.commit, from: now.ref, at: new Date().toISOString(), result: healthy ? "ok" : "failed" });
  return healthy ? { ok: true, problems: [] } : { ok: false, problems: [`rolled back to ${target.ref} but it is unhealthy`] };
}

if (import.meta.main ?? process.argv[1]?.endsWith("deploy.ts")) {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(n);
  const value = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
  const checkout = value("--checkout") ?? process.env.GAUSS_LIVE_CHECKOUT;
  if (!checkout) {
    console.error("set --checkout PATH or GAUSS_LIVE_CHECKOUT");
    process.exit(2);
  }
  const o = { ...defaultOptions(path.resolve(checkout)), dryRun: flag("--dry-run") };
  const tag = args.find((a) => /^v\d/.test(a));
  const result = flag("--rollback") ? rollback(o) : tag ? deploy(o, tag) : { ok: false, problems: ["usage: deploy vX.Y.Z | --rollback"] };
  result.problems.forEach((p) => console.error(`✗ ${p}`));
  process.exit(result.ok ? 0 : 1);
}
