/**
 * Local verification gate (GAU-120): `npm run verify`.
 *
 * GitHub Actions is billing-locked, so this is the gate a commit must pass before merge or deploy:
 *   1. baseline is well-formed (requirements/requirements.json)
 *   2. full test suite, with a JUnit report
 *   3. ops tests (scripts/ops/gauss-services.test.sh), with their own JUnit report (GAU-163)
 *   4. production build
 *   5. VCRM: every requirement verified (no failing, skipped or missing evidence), by exact test
 *      name across both reports
 * Writes test-results/verification/{junit.xml,ops-junit.xml,vcrm.json,vcrm.md}. Exits non-zero on any failure.
 *
 *   npm run verify               full gate
 *   npm run verify -- --no-build skip the build (faster while iterating)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildFmea,
  buildMatrix,
  HIGH_RESIDUAL_RISK,
  mergeOutcomes,
  parseJunit,
  renderFmeaMarkdown,
  renderMarkdown,
  validateBaseline,
  type Baseline,
  type FmeaRow,
  type TestOutcome,
} from "./vcrm.ts";

const root = path.resolve(import.meta.dirname, "../..");
const outDir = path.join(root, "test-results", "verification");
const junitPath = path.join(outDir, "junit.xml");
const opsJunitPath = path.join(outDir, "ops-junit.xml");
const skipBuild = process.argv.includes("--no-build");

function step(name: string, cmd: string, args: string[], extraEnv: Record<string, string> = {}): boolean {
  console.log(`\n▶ ${name}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...extraEnv } });
  const ok = r.status === 0;
  console.log(ok ? `✔ ${name}` : `✖ ${name} (exit ${r.status})`);
  return ok;
}

mkdirSync(outDir, { recursive: true });
// A report left by an earlier run must never stand in for a run that died before writing one.
for (const p of [junitPath, opsJunitPath]) rmSync(p, { force: true });
const baseline = JSON.parse(readFileSync(path.join(root, "requirements/requirements.json"), "utf8")) as Baseline;
const results: Record<string, boolean> = {};

const baselineProblems = validateBaseline(baseline);
console.log(`\n▶ Requirements baseline ${baseline.version} (${baseline.requirements.length} requirements)`);
baselineProblems.forEach((p) => console.log(`  ✗ ${p}`));
results.baseline = baselineProblems.length === 0;

// Same environment as `npm test`: its script may set variables before `node` (e.g.
// TSX_TSCONFIG_PATH so frontend JSX compiles with the app's settings). Read them from
// package.json rather than copying them, so the gate can't drift from `npm test`. GAU-127.
const testScript: string = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts?.test ?? "";
const testEnv = Object.fromEntries(
  [...(testScript.match(/^(?:\s*[A-Z_][A-Z0-9_]*=\S+)+/)?.[0] ?? "").matchAll(/([A-Z_][A-Z0-9_]*)=(\S+)/g)].map((m) => [m[1], m[2]]),
);
if (Object.keys(testEnv).length) console.log(`  using npm test environment: ${Object.entries(testEnv).map(([k, v]) => `${k}=${v}`).join(" ")}`);

// Same globs as `npm test`, plus a JUnit report for the matrix.
results.tests = step("Test suite", process.execPath, [
  "--import", "tsx", "--import", "./backend/test-setup.ts", "--test",
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=junit", `--test-reporter-destination=${junitPath}`,
  "backend/**/*.test.ts", "frontend/src/lib/**/*.test.ts",
], testEnv);

// Ops behaviour (watchdog, failover, dev isolation; REQ-OPS-004..007, FMEA FM-20..24). Hermetic:
// launchctl, curl, pmset and friends are stubbed and HOME is a temp dir. macOS only (plutil).
results.opsTests = step("Ops tests (bash)", "bash", ["scripts/ops/gauss-services.test.sh"], { GAUSS_OPS_JUNIT: opsJunitPath });

results.build = skipBuild ? true : step("Production build", "npm", ["run", "build", "--silent"]);

const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim() || "unknown";
const readJunit = (p: string): Map<string, TestOutcome> => (existsSync(p) ? parseJunit(readFileSync(p, "utf8")) : new Map());
const outcomes = mergeOutcomes(readJunit(junitPath), readJunit(opsJunitPath));
const rows = buildMatrix(baseline, outcomes, (p) => existsSync(path.join(root, p)));
const meta = { version: baseline.version, commit, generatedAt: new Date().toISOString() };
const fmeaPath = path.join(root, "requirements/fmea.json");
const fmea = existsSync(fmeaPath)
  ? buildFmea((JSON.parse(readFileSync(fmeaPath, "utf8")) as { rows: FmeaRow[] }).rows, outcomes)
  : [];
writeFileSync(path.join(outDir, "vcrm.json"), JSON.stringify({ ...meta, rows, fmea }, null, 2) + "\n");
writeFileSync(path.join(outDir, "vcrm.md"), renderMarkdown(rows, meta) + (fmea.length ? renderFmeaMarkdown(fmea) : ""));
const verified = rows.filter((r) => r.status === "verified").length;
console.log(`\n▶ VCRM: ${verified}/${rows.length} requirements verified (test-results/verification/vcrm.md)`);
rows.filter((r) => r.problems.length).forEach((r) => r.problems.forEach((p) => console.log(`  ✗ ${r.id}: ${p}`)));
results.vcrm = verified === rows.length;

if (fmea.length) {
  const mitigated = fmea.filter((r) => r.status === "mitigated").length;
  console.log(`\n▶ FMEA: ${mitigated}/${fmea.length} failure modes mitigated with passing evidence`);
  fmea.filter((r) => r.problems.length).forEach((r) => r.problems.forEach((p) => console.log(`  ✗ ${r.id}: ${p}`)));
  fmea.filter((r) => r.status === "gap").forEach((r) => console.log(`  ⚠ ${r.id} open gap: ${r.gap}`));
  fmea.filter((r) => r.residualRisk >= HIGH_RESIDUAL_RISK)
    .forEach((r) => console.log(`  ⚠ ${r.id} high residual risk ${r.residualRisk}: ${r.item}: ${r.failureMode}`));
  // Broken evidence fails the gate; open gaps and high residual risk are reported, not blocking.
  results.fmea = fmea.every((r) => r.status !== "broken");
}

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([k]) => k);
console.log(failed.length === 0
  ? `\n✅ VERIFY PASSED at ${commit}${skipBuild ? " (build skipped)" : ""}`
  : `\n❌ VERIFY FAILED: ${failed.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
