/**
 * Verification cross-reference matrix (VCRM) for the Constellation requirements baseline (GAU-120).
 * NASA SP-2016-6105 Rev 2 §5.3: every requirement has a verification method and evidence.
 */

export type Method = "T" | "A" | "I" | "D";
export type TestOutcome = "pass" | "fail" | "skipped";

export interface Requirement {
  id: string;
  title: string;
  statement: string;
  rationale: string;
  parent: string;
  method: Method;
  owner: string;
  /** Exact test names (method T). */
  verifiedBy?: string[];
  /** Repo-relative paths (methods A, I, D). */
  evidence?: string[];
}

export interface Baseline {
  version: string;
  requirements: Requirement[];
}

export interface RowResult {
  id: string;
  title: string;
  method: Method;
  parent: string;
  status: "verified" | "failed" | "unverified";
  evidence: Array<{ ref: string; outcome: TestOutcome | "missing" | "present" }>;
  problems: string[];
}

const ENTITIES: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
const unescapeXml = (s: string) => s.replace(/&(quot|apos|lt|gt|amp);/g, (m) => ENTITIES[m]);

/** Test outcomes by name from a Node test-runner JUnit report. A name seen more than once keeps its worst outcome. */
export function parseJunit(xml: string): Map<string, TestOutcome> {
  const out = new Map<string, TestOutcome>();
  const rank: Record<TestOutcome, number> = { pass: 0, skipped: 1, fail: 2 };
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
    if (name === undefined) continue;
    const body = m[3] ?? "";
    const outcome: TestOutcome = /<failure\b|<error\b/.test(body) ? "fail" : /<skipped\b/.test(body) ? "skipped" : "pass";
    const key = unescapeXml(name);
    const prev = out.get(key);
    if (!prev || rank[outcome] > rank[prev]) out.set(key, outcome);
  }
  return out;
}

export function validateBaseline(baseline: Baseline): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of baseline.requirements) {
    if (!/^REQ-[A-Z]+-\d{3}$/.test(r.id)) problems.push(`${r.id}: id must look like REQ-ABC-001`);
    if (seen.has(r.id)) problems.push(`${r.id}: duplicate id`);
    seen.add(r.id);
    if (!/\bshall\b/.test(r.statement)) problems.push(`${r.id}: statement must use "shall"`);
    for (const f of ["title", "rationale", "parent", "owner"] as const) if (!r[f]) problems.push(`${r.id}: missing ${f}`);
    if (!["T", "A", "I", "D"].includes(r.method)) problems.push(`${r.id}: method must be T, A, I or D`);
    if (r.method === "T" && !(r.verifiedBy?.length)) problems.push(`${r.id}: method T needs verifiedBy tests`);
    if (r.method !== "T" && !(r.evidence?.length)) problems.push(`${r.id}: method ${r.method} needs evidence paths`);
  }
  return problems;
}

/** One row per requirement. `exists` answers whether an A/I/D evidence path is present. */
export function buildMatrix(
  baseline: Baseline,
  outcomes: Map<string, TestOutcome>,
  exists: (path: string) => boolean,
): RowResult[] {
  return baseline.requirements.map((r) => {
    const problems: string[] = [];
    const evidence: RowResult["evidence"] = [];
    if (r.method === "T") {
      for (const name of r.verifiedBy ?? []) {
        const outcome = outcomes.get(name);
        evidence.push({ ref: name, outcome: outcome ?? "missing" });
        if (!outcome) problems.push(`test not found (renamed or removed?): "${name}"`);
        else if (outcome === "fail") problems.push(`test failed: "${name}"`);
        else if (outcome === "skipped") problems.push(`test skipped: "${name}"`);
      }
    } else {
      for (const path of r.evidence ?? []) {
        const present = exists(path);
        evidence.push({ ref: path, outcome: present ? "present" : "missing" });
        if (!present) problems.push(`evidence missing: ${path}`);
      }
    }
    const anyFail = evidence.some((e) => e.outcome === "fail");
    return {
      id: r.id,
      title: r.title,
      method: r.method,
      parent: r.parent,
      status: problems.length === 0 ? "verified" : anyFail ? "failed" : "unverified",
      evidence,
      problems,
    };
  });
}

export function renderMarkdown(rows: RowResult[], meta: { version: string; commit: string; generatedAt: string }): string {
  const verified = rows.filter((r) => r.status === "verified").length;
  const icon = { verified: "✅", failed: "❌", unverified: "⚠️" } as const;
  const lines = [
    `# Verification matrix (VCRM)`,
    ``,
    `Baseline ${meta.version} · commit \`${meta.commit}\` · ${meta.generatedAt}`,
    ``,
    `**${verified}/${rows.length} requirements verified.** Methods: T test, A analysis, I inspection, D demonstration.`,
    ``,
    `| Requirement | Method | Parent | Status | Evidence |`,
    `|---|---|---|---|---|`,
    ...rows.map((r) => {
      const ev = r.evidence.map((e) => `${e.outcome === "pass" || e.outcome === "present" ? "✓" : "✗"} ${e.ref.replace(/\|/g, "\\|")}`).join("<br>");
      return `| ${r.id} ${r.title} | ${r.method} | ${r.parent} | ${icon[r.status]} ${r.status} | ${ev} |`;
    }),
  ];
  const problems = rows.filter((r) => r.problems.length);
  if (problems.length) {
    lines.push("", "## Problems", "", ...problems.flatMap((r) => r.problems.map((p) => `- **${r.id}**: ${p}`)));
  }
  return lines.join("\n") + "\n";
}
