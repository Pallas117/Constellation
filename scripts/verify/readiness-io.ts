/**
 * Reads the repo for the readiness score and writes test-results/verification/readiness.{md,json}.
 * Report only: any error here is printed and swallowed, so it can never fail `npm run verify`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeReadiness, parsePolicy, renderReadinessMarkdown, summaryLine, type SourceFile } from "./readiness.ts";
import type { Baseline, FmeaRow, TestOutcome } from "./vcrm.ts";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "test-results"]);

function walk(root: string, rel: string, keep: (p: string) => boolean, out: SourceFile[] = []): SourceFile[] {
  const dir = path.join(root, rel);
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const r = `${rel}/${name}`;
    if (statSync(path.join(root, r)).isDirectory()) walk(root, r, keep, out);
    else if (keep(r)) out.push({ path: r, text: readFileSync(path.join(root, r), "utf8") });
  }
  return out;
}

export function writeReadiness(args: {
  root: string;
  outDir: string;
  baseline: Baseline;
  outcomes: Map<string, TestOutcome>;
  fmea: FmeaRow[];
  meta: { version: string; commit: string; generatedAt: string };
}): string | undefined {
  try {
    const { root } = args;
    const testFiles = [
      ...walk(root, "backend", (p) => /\.test\.ts$/.test(p)),
      ...walk(root, "frontend/src/lib", (p) => /\.test\.ts$/.test(p)),
      ...walk(root, "tests/e2e", (p) => /\.spec\.ts$/.test(p)),
      ...walk(root, "website/test", (p) => /\.test\.mjs$/.test(p)),
      ...walk(root, "scripts/ops", (p) => /\.test\.sh$/.test(p)),
    ];
    const docs = walk(root, "docs", (p) => p.endsWith(".md"));
    const rbac = path.join(root, "backend/rbac.ts");
    const report = computeReadiness({
      baseline: args.baseline,
      outcomes: args.outcomes,
      fmea: args.fmea,
      policy: existsSync(rbac) ? parsePolicy(readFileSync(rbac, "utf8")) : [],
      testFiles,
      docs,
      exists: (p) => existsSync(path.join(root, p)),
    });
    writeFileSync(path.join(args.outDir, "readiness.json"), JSON.stringify({ ...args.meta, summary: summaryLine(report), ...report }, null, 2) + "\n");
    writeFileSync(path.join(args.outDir, "readiness.md"), renderReadinessMarkdown(report, args.meta));
    return summaryLine(report);
  } catch (e) {
    console.log(`  (readiness skipped: ${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}
