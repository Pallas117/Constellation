import { test } from "node:test";
import assert from "node:assert/strict";
import { planChecks } from "./check-changed";

const on = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

test("a frontend lib change checks the app project and runs its sibling test", () => {
  const plan = planChecks(["frontend/src/lib/auth-stage.ts"], on("frontend/src/lib/auth-stage.ts", "frontend/src/lib/auth-stage.test.ts"));
  assert.deepEqual(plan.configs, ["frontend/tsconfig.app.json"]);
  assert.deepEqual(plan.tests, ["frontend/src/lib/auth-stage.test.ts"]);
  assert.deepEqual(plan.uncovered, []);
});

test("a component has no node test; a test file runs itself", () => {
  const plan = planChecks(
    ["frontend/src/components/AuthStage.tsx", "backend/commerce/plans.test.ts"],
    on("frontend/src/components/AuthStage.tsx", "backend/commerce/plans.test.ts"),
  );
  assert.deepEqual(plan.configs, ["backend/tsconfig.json", "frontend/tsconfig.app.json"]);
  assert.deepEqual(plan.tests, ["backend/commerce/plans.test.ts"]);
});

test("shared code is checked from both sides", () => {
  const plan = planChecks(["shared/proto/x.ts"], on("shared/proto/x.ts"));
  assert.deepEqual(plan.configs, ["backend/tsconfig.json", "frontend/tsconfig.app.json"]);
});

test("Playwright specs are type-checked, not run as node tests", () => {
  const plan = planChecks(["tests/e2e/auth-flow.spec.ts"], on("tests/e2e/auth-flow.spec.ts"));
  assert.deepEqual(plan.configs, ["tsconfig.tooling.json"]);
  assert.deepEqual(plan.tests, []);
});

test("files no check covers are listed for the full gate; deleted files are skipped", () => {
  const plan = planChecks(["frontend/src/index.css", "docs/X.md", "backend/gone.ts"], on("frontend/src/index.css", "docs/X.md"));
  assert.deepEqual(plan.configs, []);
  assert.deepEqual(plan.uncovered, ["frontend/src/index.css", "docs/X.md"]);
  assert.deepEqual(plan.tests, []);
});
