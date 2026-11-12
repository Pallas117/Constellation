import { spawnSync } from "node:child_process";
import path from "node:path";

type CheckStatus = "PASS" | "WARN" | "FAIL";

type CheckResult = {
  name: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  detail: string;
};

// Checks run with the Node that runs this audit. A login shell (bash -l) re-reads the
// profile, which can put another Node first; native modules built for this one then fail
// to load (NODE_MODULE_VERSION mismatch) and the test step fails for no code reason.
const CHECK_ENV = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}` };

function runCommand(name: string, command: string, opts?: { allowFail?: boolean }): CheckResult {
  const proc = spawnSync("bash", ["-c", command], {
    env: CHECK_ENV,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trim();
  const exitCode = proc.status;
  const passed = exitCode === 0;
  const status: CheckStatus = passed ? "PASS" : opts?.allowFail ? "WARN" : "FAIL";

  const detail = output.length > 800 ? `${output.slice(0, 800)}\n...<truncated>` : output;
  return {
    name,
    command,
    status,
    exitCode,
    detail,
  };
}

function printResult(result: CheckResult): void {
  console.log(`[${result.status}] ${result.name}`);
  console.log(`       cmd: ${result.command}`);
  console.log(`       exit: ${result.exitCode ?? "null"}`);
  if (result.detail.length > 0) {
    const lines = result.detail.split("\n");
    const preview = lines.slice(0, 6).join("\n");
    console.log(`       output:\n${preview}`);
    if (lines.length > 6) {
      console.log("       ...");
    }
  }
}

function summary(results: CheckResult[]): { pass: number; warn: number; fail: number } {
  return results.reduce(
    (acc, item) => {
      if (item.status === "PASS") acc.pass += 1;
      if (item.status === "WARN") acc.warn += 1;
      if (item.status === "FAIL") acc.fail += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function main(): void {
  const checks: CheckResult[] = [];

  checks.push(runCommand("TypeScript Lint", "npm run lint"));
  // Includes the RBAC role matrix and 401/403 enforcement, in process (backend/rbac.test.ts).
  checks.push(runCommand("Unit/Integration Tests", "npm test"));
  checks.push(runCommand("Production Build", "npm run build"));
  checks.push(runCommand("Backend Environment Sanity", "npm run check:backend-env"));
  checks.push(runCommand("Security Compliance Mapping Check", "npm run check:security-compliance"));

  console.log("Full Adherence Audit");
  console.log("====================");
  checks.forEach(printResult);

  const totals = summary(checks);
  console.log("");
  console.log(`Summary: PASS=${totals.pass}, WARN=${totals.warn}, FAIL=${totals.fail}`);

  if (totals.fail > 0) {
    process.exit(1);
  }
}

main();
