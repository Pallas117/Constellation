import { spawnSync } from "node:child_process";

type CheckStatus = "PASS" | "WARN" | "FAIL";

type CheckResult = {
  name: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  detail: string;
};

function hasRbacCreds(): boolean {
  const required = [
    "RBAC_VIEWER_EMAIL",
    "RBAC_VIEWER_PASSWORD",
    "RBAC_OPERATOR_EMAIL",
    "RBAC_OPERATOR_PASSWORD",
  ];
  return required.every((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function runCommand(name: string, command: string, opts?: { allowFail?: boolean }): CheckResult {
  const proc = spawnSync("bash", ["-lc", command], {
    env: process.env,
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
  checks.push(runCommand("Unit/Integration Tests", "npm test"));
  checks.push(runCommand("Production Build", "npm run build"));
  checks.push(runCommand("Backend Environment Sanity", "npm run check:backend-env"));
  checks.push(runCommand("Security Compliance Mapping Check", "npm run check:security-compliance"));

  if (hasRbacCreds()) {
    checks.push(runCommand("RBAC Runtime Smoke Test", "npm run test:rbac"));
  } else {
    checks.push({
      name: "RBAC Runtime Smoke Test",
      command: "npm run test:rbac",
      status: "WARN",
      exitCode: null,
      detail:
        "Skipped: RBAC credentials missing. Set RBAC_VIEWER/OPERATOR email+password env vars to enable runtime auth verification.",
    });
  }

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
