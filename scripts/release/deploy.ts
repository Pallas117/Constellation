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
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface DeployOptions {
  checkout: string;
  installCmd: string;
  restartCmd: string;
  healthCmd: string;
  healthWaitMs: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
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

function record(checkout: string, e: HistoryEntry) {
  appendFileSync(historyPath(checkout), JSON.stringify(e) + "\n");
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
  record(o.checkout, { action: "deploy", ref: tag, commit, from: from.ref, at: new Date().toISOString(), result: healthy ? "ok" : "failed" });
  if (healthy) {
    log(`deployed ${tag}`);
    return { ok: true, problems: [] };
  }
  log(`${tag} unhealthy: rolling back to ${from.ref}`);
  const back = activate(o, from.commit);
  record(o.checkout, { action: "auto-rollback", ref: from.ref, commit: from.commit, from: tag, at: new Date().toISOString(), result: back ? "ok" : "failed" });
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
  record(o.checkout, { action: "rollback", ref: target.ref, commit: target.commit, from: now.ref, at: new Date().toISOString(), result: healthy ? "ok" : "failed" });
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
