// check:changed: the low-power check for a branch. Type-checks only the tsconfig projects the
// change touches and runs only the test files it touches (or the tests beside the files it
// touches), so it can run on battery while the full gate waits for the merge train.
//
// Measured 17 Nov 2026 on the 8 GB Mac: frontend project type check about 10 s and 0.5 GB peak,
// against about 12 minutes for the five-gate run. It does NOT replace the gates: a change can
// break a file it didn't touch. Run the full gate with `gauss-services.sh gates enqueue`.
//
// Usage: node --import tsx scripts/check-changed.ts [base]   (default base: origin/main)
//        add --plan to print what would run without running it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface CheckPlan {
  /** tsconfig projects to type-check with scripts/quality-types.ts. */
  configs: string[];
  /** Test files for the node:test runner, as `npm test` runs them. */
  tests: string[];
  /** Changed files no check here covers (CSS, docs, Go, shell): left to the full gate. */
  uncovered: string[];
}

const PROJECTS: Array<[RegExp, string[]]> = [
  [/^frontend\/src\/.*\.tsx?$/, ["frontend/tsconfig.app.json"]],
  [/^frontend\/vite\.config\.ts$/, ["frontend/tsconfig.node.json"]],
  [/^backend\/.*\.ts$/, ["backend/tsconfig.json"]],
  // shared/ is compiled through whichever side imports it.
  [/^shared\/.*\.ts$/, ["backend/tsconfig.json", "frontend/tsconfig.app.json"]],
  [/^(scripts|tests)\/.*\.ts$|^playwright\.config\.ts$/, ["tsconfig.tooling.json"]],
];

/** Where `npm test` looks for node:test files; Playwright specs (tests/e2e) are not node tests. */
const NODE_TEST = /^(backend\/.*|frontend\/src\/lib\/.*|scripts\/.*)\.test\.ts$/;

export function planChecks(changed: readonly string[], exists: (path: string) => boolean): CheckPlan {
  const configs = new Set<string>();
  const tests = new Set<string>();
  const uncovered: string[] = [];

  for (const file of changed) {
    if (!exists(file)) continue; // deleted: its importers are what break, and they are the gate's job
    let covered = false;
    for (const [pattern, projects] of PROJECTS) {
      if (pattern.test(file)) {
        projects.forEach((p) => configs.add(p));
        covered = true;
      }
    }
    if (NODE_TEST.test(file)) {
      tests.add(file);
    } else if (/\.tsx?$/.test(file)) {
      const sibling = file.replace(/\.tsx?$/, ".test.ts");
      if (NODE_TEST.test(sibling) && exists(sibling)) tests.add(sibling);
    }
    if (!covered) uncovered.push(file);
  }

  return { configs: [...configs].sort(), tests: [...tests].sort(), uncovered };
}

function git(args: string[]): string[] {
  const run = spawnSync("git", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout.split("\n").filter(Boolean);
}

function main(argv: string[]): number {
  const planOnly = argv.includes("--plan");
  const base = argv.find((a) => !a.startsWith("--")) ?? "origin/main";
  // Committed on the branch, staged, unstaged and new files: everything this checkout changed.
  const changed = [
    ...new Set([
      ...git(["diff", "--name-only", `${base}...HEAD`]),
      ...git(["diff", "--name-only", "HEAD"]),
      ...git(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ];
  const plan = planChecks(changed, existsSync);

  console.log(`check:changed against ${base}: ${changed.length} changed file(s)`);
  console.log(`  type-check: ${plan.configs.join(", ") || "none"}`);
  console.log(`  tests:      ${plan.tests.join(", ") || "none"}`);
  if (plan.uncovered.length) console.log(`  left to the full gate: ${plan.uncovered.join(", ")}`);
  if (planOnly) return 0;

  let failed = false;
  if (plan.configs.length) {
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/quality-types.ts", ...plan.configs], { stdio: "inherit" });
    failed ||= run.status !== 0;
  }
  if (plan.tests.length) {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", "./backend/test-setup.ts", "--test", ...plan.tests],
      { stdio: "inherit", env: { ...process.env, TSX_TSCONFIG_PATH: "frontend/tsconfig.app.json" } },
    );
    failed ||= run.status !== 0;
  }
  console.log(failed ? "check:changed: FAILED" : "check:changed: passed (the full gate still decides the merge)");
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
