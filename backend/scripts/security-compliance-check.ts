import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type ControlStatus = "pass" | "warn" | "fail";

type ControlCheck = {
  id: string;
  framework: string;
  title: string;
  status: ControlStatus;
  details: string;
};

function repoRoot(): string {
  const currentFile = decodeURIComponent(new URL(import.meta.url).pathname);
  return path.resolve(path.dirname(currentFile), "..", "..");
}

function checkFileContains(relativePath: string, pattern: RegExp): boolean {
  const full = path.join(repoRoot(), relativePath);
  if (!existsSync(full)) {
    return false;
  }
  return pattern.test(readFileSync(full, "utf8"));
}

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value) {
    return fallback;
  }
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function runChecks(): ControlCheck[] {
  const checks: ControlCheck[] = [];
  const authRequired = envBool("AUTH_REQUIRED", true);
  checks.push({
    id: "NIST-AC-3",
    framework: "NIST SP 800-53 Rev.5",
    title: "Access enforcement with authenticated API boundary",
    status: authRequired ? "pass" : "warn",
    details: authRequired
      ? "AUTH_REQUIRED is enabled by default."
      : "AUTH_REQUIRED=false detected. Use only for local non-production debugging.",
  });

  const hasRoleGate = checkFileContains("backend/server.ts", /requireRole\("admin"\)|requireRole\("operator"\)/);
  checks.push({
    id: "NIST-CSF-PR.AA",
    framework: "NIST CSF 2.0",
    title: "Role-based authorization control",
    status: hasRoleGate ? "pass" : "fail",
    details: hasRoleGate
      ? "Role gate calls found in backend routes."
      : "No role gate calls detected in backend routes.",
  });

  const hasAuditEvents = checkFileContains("backend/cybertiger/daemon.ts", /type:\s*"auth\.failure"|type:\s*"ip\.blocked"/);
  checks.push({
    id: "ISO-A.8.15",
    framework: "ISO/IEC 27001:2022",
    title: "Logging and security event traceability",
    status: hasAuditEvents ? "pass" : "fail",
    details: hasAuditEvents
      ? "CyberTiger event generation patterns detected."
      : "CyberTiger event generation patterns not detected.",
  });

  const hasRateLimit = checkFileContains("backend/cybertiger/daemon.ts", /rateLimitWindowMs|applyRateLimit/);
  checks.push({
    id: "NIST-SC-7",
    framework: "NIST SP 800-53 Rev.5",
    title: "Boundary protection and request throttling",
    status: hasRateLimit ? "pass" : "fail",
    details: hasRateLimit
      ? "Rate-limiting controls present in daemon implementation."
      : "Rate-limiting controls missing in daemon implementation.",
  });

  const hasSignatureDetection = checkFileContains("backend/cybertiger/daemon.ts", /SIGNATURE_PATTERNS|detectSignature/);
  checks.push({
    id: "NIST-SI-4",
    framework: "NIST SP 800-53 Rev.5",
    title: "Security monitoring and anomaly detection",
    status: hasSignatureDetection ? "pass" : "fail",
    details: hasSignatureDetection
      ? "Signature-based detection controls present."
      : "Signature-based detection controls missing.",
  });

  const hasSpaceGuidanceDoc = existsSync(path.join(repoRoot(), "docs", "CYBERTIGER_COMPLIANCE_BASELINE.md"));
  checks.push({
    id: "SPACE-NISTIR-8401",
    framework: "NISTIR 8401 / Satellite Ground Segment",
    title: "Documented mapping to satellite cybersecurity guidance",
    status: hasSpaceGuidanceDoc ? "pass" : "warn",
    details: hasSpaceGuidanceDoc
      ? "Compliance baseline document present."
      : "Compliance baseline document missing.",
  });

  return checks;
}

function main(): void {
  const checks = runChecks();
  let failed = 0;
  let warned = 0;

  console.log("CyberTiger Security Compliance Check");
  console.log("====================================");
  for (const check of checks) {
    if (check.status === "fail") failed += 1;
    if (check.status === "warn") warned += 1;
    const prefix = check.status.toUpperCase().padEnd(4, " ");
    console.log(`[${prefix}] ${check.id} (${check.framework}) - ${check.title}`);
    console.log(`       ${check.details}`);
  }

  console.log("");
  console.log(`Summary: ${checks.length} checks, ${failed} fail, ${warned} warn`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
