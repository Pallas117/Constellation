/**
 * Implementation Readiness Score, computed by `npm run verify` (report only; it never fails the gate).
 *
 * Per requirement, 0-100 from evidence the repo already has, rolled up per parent Linear issue.
 * Pure functions over parsed inputs: no file system, no network (the reading is in readiness-io.ts).
 *
 *   Specification   15  baseline rules, one "shall", measurable, rationale and parent
 *   Verification    30  every mapped test passed in this run (method T: 2+ tests beat 1)
 *   End-to-end      20  user-facing paths have a test that drives the whole path
 *   Failure analysis 15 FMEA rows citing the requirement's tests are mitigated
 *   Security        10  route has an explicit access level and a 401/403 test
 *   Documentation   10  key paths are mentioned in docs/
 *
 * The heuristics are deliberately simple and listed in requirements/README.md; a low part is a to-do.
 */
import {
  HIGH_RESIDUAL_RISK,
  validateBaseline,
  type Baseline,
  type FmeaRow,
  type Requirement,
  type TestOutcome,
} from "./vcrm.ts";

export interface PolicyEntry {
  method: string;
  path: string;
  access: string;
}
export interface SourceFile {
  path: string;
  text: string;
}
export interface ReadinessInput {
  baseline: Baseline;
  outcomes: Map<string, TestOutcome>;
  fmea: FmeaRow[];
  policy: PolicyEntry[];
  /** Test files (node, e2e, website, ops): where mapped tests live and what routes they call. */
  testFiles: SourceFile[];
  /** docs/*.md */
  docs: SourceFile[];
  exists: (path: string) => boolean;
}

export const PART_MAX = {
  specification: 15,
  verification: 30,
  endToEnd: 20,
  failureAnalysis: 15,
  security: 10,
  documentation: 10,
} as const;
export type PartName = keyof typeof PART_MAX;

export interface Part {
  score: number;
  max: number;
  reason: string;
  /** Missing evidence for this part. */
  todo: string[];
}
export interface RequirementReadiness {
  id: string;
  title: string;
  parent: string;
  score: number;
  parts: Record<PartName, Part>;
  routes: string[];
  todo: string[];
}
export interface IssueReadiness {
  parent: string;
  score: number;
  requirements: number;
  parts: Record<PartName, number>;
  todo: string[];
}
export interface ReadinessReport {
  median: number;
  below: string[];
  threshold: number;
  requirements: RequirementReadiness[];
  issues: IssueReadiness[];
}

export const LOW_READINESS = 60;
const BODY_CAP = 6000;
const PARTS = Object.keys(PART_MAX) as PartName[];

export function parsePolicy(rbacText: string): PolicyEntry[] {
  const out: PolicyEntry[] = [];
  const re = /\{\s*method:\s*"(\w+)",\s*path:\s*"([^"]+)",\s*access:\s*"(\w+)"\s*\}/g;
  for (let m = re.exec(rbacText); m; m = re.exec(rbacText)) out.push({ method: m[1], path: m[2], access: m[3] });
  return out;
}

/** The text of the test called `name`: from its title to the next top-level test, capped. */
export function testBody(files: SourceFile[], name: string): { file?: string; body: string } {
  for (const f of files) {
    const i = f.text.indexOf(name);
    if (i < 0) continue;
    const rest = f.text.slice(i);
    const next = rest.slice(name.length).search(/\n(?:test|it|describe)\(/);
    return { file: f.path, body: rest.slice(0, next < 0 ? BODY_CAP : Math.min(next + name.length, BODY_CAP)) };
  }
  return { body: "" };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A policy path as a regex over source text: ":id" matches any segment or a ${template}. */
export function routeRegex(policyPath: string): RegExp {
  const seg = policyPath
    .split("/")
    .map((s) => (s.startsWith(":") ? "(?:[^/\\s'\"`]|\\$\\{[^}]*\\})+" : escapeRe(s)))
    .join("/");
  return new RegExp(`${seg}(?![\\w/-])`);
}

const lastTwo = (p: string) => p.replace(/\.[a-z]+$/, "").split("/").slice(-2).join("/");
const isUserFacingPath = (p: string) => /^(frontend\/src\/(pages|components)\/|website\/(worker|public)\/)/.test(p);
const isE2eFile = (p: string) => /^tests\/e2e\//.test(p) || /^backend\/server\..*\.test\.ts$/.test(p) || /^website\/test\//.test(p);
const maxMeasured = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(n)));

function specification(r: Requirement, baselineProblems: string[]): Part {
  const todo: string[] = [];
  let score = 0;
  const own = baselineProblems.filter((p) => p.startsWith(`${r.id}:`));
  if (own.length === 0) score += 4;
  else todo.push(...own.map((p) => `baseline: ${p}`));
  const shalls = (r.statement.match(/\bshall\b/g) ?? []).length;
  if (shalls === 1) score += 4;
  else todo.push(`statement has ${shalls} "shall"; split it so each requirement has exactly one`);
  const measurable = /\d/.test(r.statement) || /\b(?:one of|either|each of|all of|both)\b/i.test(r.statement) || /[^,]+,[^,]+,\s*(?:and|or)\s/.test(r.statement);
  if (measurable) score += 4;
  else todo.push("statement has no number or enumerated value; make it measurable");
  const hasParent = /^GAU-\d+$/.test(r.parent ?? "");
  if (r.rationale?.trim() && hasParent) score += 3;
  else todo.push("add a rationale and a parent Linear issue (GAU-NN)");
  return { score, max: PART_MAX.specification, reason: todo.length ? "see to-do" : "baseline-valid, singular, measurable", todo };
}

function verification(r: Requirement, input: ReadinessInput): Part {
  const max = PART_MAX.verification;
  if (r.method !== "T") {
    const paths = r.evidence ?? [];
    const missing = paths.filter((p) => !input.exists(p));
    if (!paths.length || missing.length) {
      return { score: 0, max, reason: `method ${r.method}: evidence missing`, todo: missing.length ? missing.map((p) => `evidence path missing: ${p}`) : [`name evidence paths for method ${r.method}`] };
    }
    return { score: 18, max, reason: `method ${r.method}: ${paths.length} evidence path(s) present, no automated test`, todo: ["add an automated test (method T) to earn the full part"] };
  }
  const names = r.verifiedBy ?? [];
  const bad = names.filter((n) => input.outcomes.get(n) !== "pass");
  if (!names.length || bad.length) {
    return { score: 0, max, reason: "a mapped test failed, was skipped or was not found", todo: bad.map((n) => `${input.outcomes.get(n) ?? "missing"}: "${n}"`) };
  }
  return names.length >= 2
    ? { score: max, max, reason: `${names.length} tests passed`, todo: [] }
    : { score: 22, max, reason: "1 test passed", todo: ["add a second test (a failure case or boundary) for full marks"] };
}

interface Facts {
  routes: PolicyEntry[];
  files: string[];
  keyPaths: string[];
  ownText: string;
}

function gather(r: Requirement, input: ReadinessInput): Facts {
  const files = new Set<string>();
  let ownText = r.statement;
  for (const n of r.verifiedBy ?? []) {
    const { file, body } = testBody(input.testFiles, n);
    if (file) files.add(file);
    ownText += `\n${body}`;
  }
  const keyPaths = [...new Set([...(r.evidence ?? []), ...files])];
  const seen = new Set<string>();
  const routes = input.policy.filter((p) => {
    const key = `${p.method} ${p.path}`;
    if (seen.has(key) || !routeRegex(p.path).test(ownText)) return false;
    seen.add(key);
    return true;
  });
  return { routes, files: [...files], keyPaths, ownText };
}

function endToEnd(f: Facts, input: ReadinessInput): Part {
  const max = PART_MAX.endToEnd;
  const pages = f.keyPaths.filter(isUserFacingPath);
  if (!f.routes.length && !pages.length) return { score: max, max, reason: "internal", todo: [] };
  const e2e = input.testFiles.filter((t) => isE2eFile(t.path));
  const todo: string[] = [];
  const covered = (hit: (t: SourceFile) => boolean) => e2e.some(hit);
  const routeOk = f.routes.map((p) => ({ p, ok: covered((t) => routeRegex(p.path).test(t.text)) }));
  const pageOk = pages.map((p) => ({ p, ok: covered((t) => t.text.includes(lastTwo(p))) }));
  routeOk.filter((x) => !x.ok).forEach((x) => todo.push(`no e2e/server/website test calls ${x.p.method} ${x.p.path}`));
  pageOk.filter((x) => !x.ok).forEach((x) => todo.push(`no e2e/website test drives ${x.p}`));
  const all = [...routeOk, ...pageOk];
  const hit = all.filter((x) => x.ok).length;
  return { score: maxMeasured((max * hit) / all.length, max), max, reason: `${hit}/${all.length} user-facing paths driven end to end`, todo };
}

function failureAnalysis(r: Requirement, input: ReadinessInput): Part {
  const max = PART_MAX.failureAnalysis;
  const mine = new Set(r.verifiedBy ?? []);
  const rows = input.fmea.filter((row) => row.verifiedBy.some((n) => mine.has(n)));
  if (!rows.length) return { score: max, max, reason: "no FMEA row cites its tests", todo: [] };
  const todo: string[] = [];
  let ok = 0;
  let high = 0;
  for (const row of rows) {
    const broken = row.verifiedBy.some((n) => input.outcomes.get(n) !== "pass");
    if (row.gap) todo.push(`${row.id} open gap: ${row.gap}`);
    else if (broken) todo.push(`${row.id} cites a test that did not pass`);
    else ok++;
    if (row.severity * row.residualLikelihood >= HIGH_RESIDUAL_RISK) {
      high++;
      todo.push(`${row.id} high residual risk ${row.severity * row.residualLikelihood}`);
    }
  }
  return { score: maxMeasured((max * ok) / rows.length - 3 * high, max), max, reason: `${ok}/${rows.length} FMEA rows mitigated`, todo };
}

function security(f: Facts, input: ReadinessInput): Part {
  const max = PART_MAX.security;
  if (!f.routes.length) return { score: max, max, reason: "no API route", todo: [] };
  const todo: string[] = [];
  const own401 = /\b40[13]\b/.test(f.ownText);
  const asserted = f.routes.filter((p) => own401 || input.testFiles.some((t) => /\b40[13]\b/.test(t.text) && routeRegex(p.path).test(t.text)));
  const policied = f.routes.filter((p) => !!p.access);
  f.routes.filter((p) => !asserted.includes(p)).forEach((p) => todo.push(`no test asserts 401/403 for ${p.method} ${p.path}`));
  const score = maxMeasured((max / 2) * (policied.length / f.routes.length) + (max / 2) * (asserted.length / f.routes.length), max);
  return { score, max, reason: `${policied.length}/${f.routes.length} routes with explicit access, ${asserted.length}/${f.routes.length} with a 401/403 test`, todo };
}

function documentation(f: Facts, input: ReadinessInput): Part {
  const max = PART_MAX.documentation;
  if (!f.keyPaths.length) return { score: 0, max, reason: "no key paths found", todo: ["name evidence paths or map a test that lives in a file"] };
  const docText = input.docs.map((d) => d.text).join("\n");
  const stem = (p: string) => (p.split("/").pop() ?? p).replace(/\.(test|spec)\.[a-z]+$|\.[a-z]+$/, "");
  const undocumented = f.keyPaths.filter((p) => !docText.includes(p) && !docText.includes(stem(p)));
  const hit = f.keyPaths.length - undocumented.length;
  return {
    score: maxMeasured((max * hit) / f.keyPaths.length, max),
    max,
    reason: `${hit}/${f.keyPaths.length} key paths mentioned in docs/`,
    todo: undocumented.map((p) => `mention ${p} in docs/ARCHITECTURE.md or the relevant docs file`),
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export function computeReadiness(input: ReadinessInput): ReadinessReport {
  const baselineProblems = validateBaseline(input.baseline);
  const requirements: RequirementReadiness[] = input.baseline.requirements.map((r) => {
    const f = gather(r, input);
    const parts: Record<PartName, Part> = {
      specification: specification(r, baselineProblems),
      verification: verification(r, input),
      endToEnd: endToEnd(f, input),
      failureAnalysis: failureAnalysis(r, input),
      security: security(f, input),
      documentation: documentation(f, input),
    };
    const score = PARTS.reduce((s, k) => s + parts[k].score, 0);
    return {
      id: r.id,
      title: r.title,
      parent: r.parent,
      score,
      parts,
      routes: f.routes.map((p) => `${p.method} ${p.path}`),
      todo: PARTS.flatMap((k) => parts[k].todo.map((t) => `[${k}] ${t}`)),
    };
  });
  const byParent = new Map<string, RequirementReadiness[]>();
  for (const q of requirements) byParent.set(q.parent, [...(byParent.get(q.parent) ?? []), q]);
  const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  const issues: IssueReadiness[] = [...byParent.entries()]
    .map(([parent, qs]) => ({
      parent,
      score: mean(qs.map((q) => q.score)),
      requirements: qs.length,
      parts: Object.fromEntries(PARTS.map((k) => [k, mean(qs.map((q) => q.parts[k].score))])) as Record<PartName, number>,
      todo: qs.flatMap((q) => q.todo.map((t) => `${q.id} ${t}`)),
    }))
    .sort((a, b) => a.score - b.score || a.parent.localeCompare(b.parent, "en", { numeric: true }));
  return {
    median: median(requirements.map((q) => q.score)),
    below: requirements.filter((q) => q.score < LOW_READINESS).map((q) => q.id),
    threshold: LOW_READINESS,
    requirements,
    issues,
  };
}

/** One line for the gate. */
export function summaryLine(report: ReadinessReport, listMax = 8): string {
  const n = report.below.length;
  if (!n) return `readiness: median ${report.median}, no requirement below ${report.threshold}`;
  const shown = report.below.slice(0, listMax).join(", ") + (n > listMax ? `, +${n - listMax} more` : "");
  return `readiness: median ${report.median}, ${n} requirement${n === 1 ? "" : "s"} below ${report.threshold}: ${shown}`;
}

export function renderReadinessMarkdown(report: ReadinessReport, meta: { version: string; commit: string; generatedAt: string }): string {
  const cell = (p: Part) => `${p.score}/${p.max}`;
  const lines = [
    "# Implementation readiness (computed, not self-reported)",
    "",
    `Baseline ${meta.version} · commit \`${meta.commit}\` · ${meta.generatedAt}`,
    "",
    `**${summaryLine(report)}**`,
    "",
    "Parts: specification 15, verification 30, end-to-end 20, failure analysis 15, security 10, documentation 10. Report only: it does not fail the gate. See requirements/README.md.",
    "",
    "## Per parent issue",
    "",
    "| Issue | Score | Requirements | Spec | Verif | E2E | FMEA | Sec | Docs |",
    "|---|---|---|---|---|---|---|---|---|",
    ...report.issues.map((i) => `| ${i.parent} | ${i.score} | ${i.requirements} | ${i.parts.specification} | ${i.parts.verification} | ${i.parts.endToEnd} | ${i.parts.failureAnalysis} | ${i.parts.security} | ${i.parts.documentation} |`),
    "",
    "## Per requirement",
    "",
    "| Requirement | Parent | Score | Spec | Verif | E2E | FMEA | Sec | Docs |",
    "|---|---|---|---|---|---|---|---|---|",
    ...report.requirements.map((q) => `| ${q.id} ${q.title} | ${q.parent} | ${q.score} | ${PARTS.map((k) => cell(q.parts[k])).join(" | ")} |`),
  ];
  const low = report.requirements.filter((q) => q.todo.length).sort((a, b) => a.score - b.score);
  if (low.length) {
    lines.push("", "## To-do (missing evidence, lowest score first)", "");
    for (const q of low) lines.push(`- **${q.id}** (${q.score}): ${q.todo.map((t) => t.replace(/\|/g, "\\|")).join("; ")}`);
  }
  return lines.join("\n") + "\n";
}
