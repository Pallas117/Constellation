import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { audienceOf, buildIndex, EXPORT_DIR, gardenDir, graphFor, noteFor, stripFrontmatter } from "./garden.js";

function garden(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "garden-"));
  const put = (rel: string, text: string) => {
    const full = path.join(dir, EXPORT_DIR, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  put("Home.md", "# Cosmic Brain\n[[MOCs/Corpus - member|member]] [[MOCs/Memory - user|user]]\n");
  put("MOCs/Corpus - member.md", "# Member corpus\n- [[Corpus/member/onboarding|onboarding]]\n");
  put("MOCs/Corpus - operator.md", "# Operator corpus\n- [[Corpus/operator/runbook]]\n");
  put("MOCs/Memory - user.md", "# user\n- [[Memory/memory/user-josh|user-josh]]\n");
  put("Corpus/member/onboarding.md", "---\nsha256: abc\n---\n# Onboarding\nSee [[runbook]] and [[user-josh|Josh's notes]].\n");
  put("Corpus/operator/runbook.md", "# Runbook\nBack to [[onboarding]]; also [[Memory/memory/user-josh]].\n");
  put("Memory/memory/user-josh.md", "---\nname: user-josh\noriginSessionId: s1\n---\nJosh is in Malaysia.\n");
  put("Inbox/Edited exports/x.md", "# edited\n");
  writeFileSync(path.join(dir, "CLAUDE.md"), "# agent notes\n");
  return dir;
}

test("audience follows the brain's catalogs; anything else is never served", () => {
  assert.equal(audienceOf("Corpus/member/a.md"), "staff");
  assert.equal(audienceOf("Corpus/operator/a.md"), "operator");
  assert.equal(audienceOf("MOCs/Corpus - member.md"), "staff");
  assert.equal(audienceOf("MOCs/Corpus - operator.md"), "operator");
  assert.equal(audienceOf("MOCs/Memory - user.md"), "admin");
  assert.equal(audienceOf("Memory/memory/x.md"), "admin");
  assert.equal(audienceOf("Home.md"), "admin");
  for (const never of ["Inbox/Edited exports/x.md", "Corpus/public/a.md", "Corpus/other/a.md", "MOCs/Other.md", "Corpus/member/a.tsv", "CLAUDE.md"]) {
    assert.equal(audienceOf(never), null, never);
  }
});

test("staff see only member notes, and links to hidden notes are dropped", () => {
  const notes = buildIndex(garden());
  const g = graphFor(notes, "staff", new Date(0));
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["Corpus/member/onboarding", "MOCs/Corpus - member"]);
  assert.deepEqual(g.links, [{ source: "MOCs/Corpus - member", target: "Corpus/member/onboarding" }]);
  assert.equal(g.nodes.find((n) => n.id === "Corpus/member/onboarding")?.title, "Onboarding");
});

test("operators add the operator corpus; only admin sees memories and Home", () => {
  const notes = buildIndex(garden());
  const op = graphFor(notes, "operator", new Date(0)).nodes.map((n) => n.id);
  assert.ok(op.includes("Corpus/operator/runbook") && op.includes("Corpus/member/onboarding"));
  assert.ok(!op.some((id) => id.startsWith("Memory/") || id === "Home" || id.startsWith("MOCs/Memory")));
  const admin = graphFor(notes, "admin", new Date(0));
  assert.equal(admin.nodes.length, 7);
  assert.ok(admin.links.some((l) => l.source === "Corpus/operator/runbook" && l.target === "Memory/memory/user-josh"));
  assert.equal(graphFor(notes, "user", new Date(0)).nodes.length, 0);
});

test("a note above the caller's role is 404-equivalent, and hidden link names don't leak", () => {
  const notes = buildIndex(garden());
  assert.equal(noteFor(notes, "staff", "Corpus/operator/runbook"), null);
  assert.equal(noteFor(notes, "operator", "Memory/memory/user-josh"), null);
  assert.equal(noteFor(notes, "staff", "../../etc/passwd"), null);
  const staff = noteFor(notes, "staff", "Corpus/member/onboarding");
  assert.equal(staff?.markdown, "# Onboarding\nSee (note not shown) and Josh's notes.\n");
  const op = noteFor(notes, "operator", "Corpus/member/onboarding");
  assert.equal(op?.markdown, "# Onboarding\nSee [[runbook]] and Josh's notes.\n");
  assert.equal(noteFor(notes, "admin", "Memory/memory/user-josh")?.markdown, "Josh is in Malaysia.\n", "frontmatter stripped");
});

test("symlinks are never followed out of the export", () => {
  const dir = garden();
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  writeFileSync(path.join(outside, "secret.md"), "# secret\n");
  symlinkSync(outside, path.join(dir, EXPORT_DIR, "Corpus", "member", "linked"));
  symlinkSync(path.join(outside, "secret.md"), path.join(dir, EXPORT_DIR, "Corpus", "member", "secret.md"));
  const ids = graphFor(buildIndex(dir), "admin", new Date(0)).nodes.map((n) => n.id);
  assert.ok(!ids.some((id) => id.includes("secret") || id.includes("linked")), ids.join(","));
});

test("configuration and frontmatter helpers", () => {
  assert.equal(gardenDir(undefined), null);
  assert.equal(gardenDir("relative/garden"), null);
  assert.equal(gardenDir("/Users/x/gauss/garden/"), "/Users/x/gauss/garden");
  assert.equal(stripFrontmatter("---\na: 1\n---\nbody\n"), "body\n");
  assert.equal(stripFrontmatter("no frontmatter"), "no frontmatter");
});
