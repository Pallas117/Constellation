import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEvent, deploy, readHistory, redact, rollback, type DeployOptions } from "../../scripts/release/deploy.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

/** origin (bare) + a dev clone that makes releases + a "live" clone that gets deployed. */
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deploy-"));
  const origin = path.join(dir, "origin.git");
  git(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  const dev = path.join(dir, "dev");
  git(dir, "clone", "--quiet", origin, dev);
  git(dev, "config", "user.email", "t@t"); git(dev, "config", "user.name", "t");
  const release = (tag: string, verified: boolean, onMain = true) => {
    if (!onMain) git(dev, "checkout", "--quiet", "-B", "side");
    writeFileSync(path.join(dev, "f.txt"), tag);
    git(dev, "add", "."); git(dev, "commit", "--quiet", "-m", tag);
    git(dev, "tag", "-a", tag, "-m", verified ? `Release ${tag}\n✅ VERIFY PASSED at abc` : `Release ${tag}`);
    git(dev, "push", "--quiet", "origin", "HEAD", "--tags");
    if (!onMain) git(dev, "checkout", "--quiet", "main");
  };
  git(dev, "checkout", "--quiet", "-b", "main");
  release("v1.0.0", true);
  const live = path.join(dir, "live");
  git(dir, "clone", "--quiet", origin, live);
  // Health is read from a file so a test can make the next release unhealthy.
  const healthFile = path.join(dir, "health");
  writeFileSync(healthFile, "0");
  const o: DeployOptions = {
    checkout: live, installCmd: "true", restartCmd: "true",
    healthCmd: `exit $(cat ${healthFile})`, healthWaitMs: 0, log: () => undefined,
  };
  return { dev, live, release, o, setHealth: (code: number) => writeFileSync(healthFile, String(code)) };
}

test("deploy: only verified tags on main to a clean checkout (GAU-123)", () => {
  const f = fixture();
  f.release("v1.1.0", false);
  f.release("v1.2.0", true, false);
  assert.match(deploy(f.o, "v1.1.0").problems.join(), /no verify evidence/);
  assert.match(deploy(f.o, "v1.2.0").problems.join(), /not on origin\/main/);
  assert.match(deploy(f.o, "v9.9.9").problems.join(), /not found/);
  writeFileSync(path.join(f.live, "f.txt"), "local edit");
  assert.match(deploy(f.o, "v1.0.0").problems.join(), /local changes/);
});

test("deploy: healthy release is activated and recorded; dry run changes nothing (GAU-123)", () => {
  const f = fixture();
  f.release("v1.1.0", true);
  const before = git(f.live, "rev-parse", "HEAD");
  assert.equal(deploy({ ...f.o, dryRun: true }, "v1.1.0").ok, true);
  assert.equal(git(f.live, "rev-parse", "HEAD"), before, "dry run does not move the checkout");
  assert.deepEqual(deploy(f.o, "v1.1.0"), { ok: true, problems: [] });
  assert.equal(git(f.live, "describe", "--tags", "--exact-match"), "v1.1.0");
  assert.deepEqual(readHistory(f.live).map((e) => [e.action, e.ref, e.result]), [["deploy", "v1.1.0", "ok"]]);
});

test("deploy: an unhealthy release rolls back automatically (GAU-123)", () => {
  const f = fixture();
  f.release("v1.1.0", true);
  assert.equal(deploy(f.o, "v1.1.0").ok, true);
  f.release("v1.2.0", true);
  f.setHealth(2); // red
  const res = deploy(f.o, "v1.2.0");
  assert.equal(res.ok, false);
  assert.match(res.problems[0], /rolled back to v1\.1\.0/);
  assert.equal(git(f.live, "describe", "--tags", "--exact-match"), "v1.1.0", "back on the last good release");
  assert.deepEqual(readHistory(f.live).map((e) => e.action), ["deploy", "deploy", "auto-rollback"]);
});

test("rollback: returns to the previous healthy release (GAU-123)", () => {
  const f = fixture();
  f.release("v1.1.0", true);
  f.release("v1.2.0", true);
  assert.equal(deploy(f.o, "v1.1.0").ok, true);
  assert.equal(deploy(f.o, "v1.2.0").ok, true);
  assert.equal(rollback(f.o).ok, true);
  assert.equal(git(f.live, "describe", "--tags", "--exact-match"), "v1.1.0");
  assert.equal(readHistory(f.live).at(-1)!.action, "rollback");
});

test("deploy: deploy and rollback are events in events.jsonl with live_sha (GAU-164)", () => {
  const f = fixture();
  const eventsLog = path.join(mkdtempSync(path.join(os.tmpdir(), "events-")), "events.jsonl");
  const o = { ...f.o, eventsLog };
  f.release("v1.1.0", true);
  assert.equal(deploy(o, "v1.1.0").ok, true);
  f.release("v1.2.0", true);
  f.setHealth(2);
  assert.equal(deploy(o, "v1.2.0").ok, false);
  const lines = readFileSync(eventsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const want = ["ts", "host", "event", "label", "reason", "live_sha", "fallback_sha", "pressure", "swap_mb", "battery", "on_ac"];
  for (const l of lines) assert.deepEqual(want.filter((k) => !(k in l)), [], "every line has the shell's fields");
  assert.deepEqual(lines.map((l) => [l.event, l.label, l.result]), [["deploy", "v1.1.0", "ok"], ["deploy", "v1.2.0", "failed"], ["rollback", "v1.1.0", "failed"]], "health stays red in this fixture, so the rollback is recorded as failed");
  const v110 = git(f.live, "rev-parse", "v1.1.0^{commit}");
  assert.equal(lines[0].live_sha, v110);
  assert.equal(lines[2].live_sha, v110, "after the rollback live is on v1.1.0 again");
});

test("events: secrets redacted and the log rotates by size (GAU-164)", () => {
  assert.equal(redact("https://u:pw@h.example/p?token=abc api_key=s3cr3t"), "https://h.example/p?<redacted> api_key=<redacted>");
  const f = fixture();
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "events-")), "events.jsonl");
  writeFileSync(file, "x".repeat(2048) + "\n");
  appendEvent(file, f.live, { event: "deploy", label: "v1", reason: "see https://h/x?token=t" }, 1);
  assert.ok(statSync(`${file}.1`).size > 2048, "the full file moved aside");
  const e = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.equal(e.reason, "see https://h/x?<redacted>");
});
