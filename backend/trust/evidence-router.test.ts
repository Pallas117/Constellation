import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { enforceApiPolicy } from "../rbac.js";
import type { EvidencePack } from "./evidence.js";
import { renderEvidencePdf } from "./evidence-pdf.js";
import { createEvidenceRouter, KEYRING_LABEL, MAX_LOG_BYTES, SIGN_ON_HOST } from "./evidence-router.js";
import { clone, csv, mapping, packFromStoredInputs } from "./fixtures/evidence-pack.js";
import { packFileText, PilotError, REPO_ROOT, runPilot, type PilotResult, type PilotRunner } from "./pilot-run.js";

const NOT_SIGNED = "the pack is not signed, so nothing shows who made it (integrity only)";

/** The router as the server mounts it: a session (here: the x-test-role header), then API_POLICY. */
async function withApi(fn: (call: Call) => Promise<void>, run?: PilotRunner) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", (req: AuthenticatedRequest, _res, next) => {
    const role = req.header("x-test-role") as AuthRole | undefined;
    if (role) req.auth = { userId: "u1", email: "t@example.org", role, rawRoles: [role], token: "t" };
    next();
  });
  app.use("/api", enforceApiPolicy);
  app.use("/api/trust/evidence", createEvidenceRouter({ run: run ?? (async () => fixtureResult()) }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/trust/evidence`;
  try {
    await fn((role, method, path, body) =>
      fetch(base + path, {
        method,
        headers: { ...(role ? { "x-test-role": role } : {}), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  } finally {
    server.close();
  }
}
type Call = (role: AuthRole | null, method: "GET" | "POST", path: string, body?: unknown) => Promise<Response>;

async function fixtureResult(): Promise<PilotResult> {
  const { pack, records } = await packFromStoredInputs();
  return { summary: { file: { sha256: pack.inputs.log!.fileSha256, bytes: csv.length, rows: 9 }, mapping: { id: "generic-csv", version: "0.1.0" }, accepted: 3, rejected: pack.inputs.log!.rejected, verdicts: {} }, records, pack };
}
const analyseBody = { log: csv.toString("utf8"), mappingId: "generic-csv", eventId: "jan-2026" };

test("evidence routes: operators and admins only; no session 401, user and staff 403 (GAU-59)", async () => {
  await withApi(async (call) => {
    const { pack } = await packFromStoredInputs();
    const routes: Array<["GET" | "POST", string, unknown]> = [
      ["GET", "/options", undefined],
      ["POST", "/analyse", analyseBody],
      ["POST", "/verify", { pack, allowUnsigned: true }],
      ["POST", "/pdf", { pack }],
    ];
    for (const [method, path, body] of routes) {
      assert.equal((await call(null, method, path, body)).status, 401, `${method} ${path} without a session`);
      assert.equal((await call("user", method, path, body)).status, 403, `${method} ${path} as user`);
      assert.equal((await call("staff", method, path, body)).status, 403, `${method} ${path} as staff`);
      assert.equal((await call("operator", method, path, body)).status, 200, `${method} ${path} as operator`);
      assert.equal((await call("admin", method, path, body)).status, 200, `${method} ${path} as admin`);
    }
  });
});

test("evidence routes: there is no signing route, and nothing private in the options", async () => {
  await withApi(async (call) => {
    for (const path of ["/sign", "/keys", "/analyse/sign"]) assert.equal((await call("admin", "POST", path, {})).status, 404, path);
    const res = await call("operator", "GET", "/options");
    const text = await res.text();
    assert.doesNotMatch(text, /PRIVATE KEY|sign-key":|\/Users\/|\/home\//);
    const options = JSON.parse(text) as { events: Array<{ id: string; title: string | null }>; mappings: Array<{ id: string }>; sample: { name: string; text: string }; keys: Array<Record<string, unknown>>; signOnHost: string; keyring: string };
    assert.ok(options.events.some((e) => e.id === "jan-2026" && e.title));
    assert.deepEqual(options.mappings.map((m) => m.id), ["generic-csv"]);
    assert.equal(options.sample.text, csv.toString("utf8"));
    assert.equal(options.signOnHost, SIGN_ON_HOST);
    assert.equal(options.keyring, KEYRING_LABEL);
    for (const k of options.keys) assert.deepEqual(Object.keys(k).sort(), ["keyId", "purposes", "status"]);
  });
});

test("evidence analyse: returns the report, records and an unsigned pack; refuses bad input with the reason", async () => {
  const seen: Array<{ bytes: number; mappingId: string; eventId: string }> = [];
  const run: PilotRunner = async (input) => {
    seen.push({ bytes: input.log.length, mappingId: input.mapping.id, eventId: input.eventId });
    return fixtureResult();
  };
  await withApi(async (call) => {
    const res = await call("operator", "POST", "/analyse", analyseBody);
    const body = (await res.json()) as PilotResult & { signed: boolean; signOnHost: string };
    assert.equal(body.signed, false);
    assert.equal(body.pack.signature, null);
    assert.equal(body.records.length, 3);
    assert.equal(body.summary.rejected.length, 6);
    assert.deepEqual(seen, [{ bytes: csv.length, mappingId: "generic-csv", eventId: "jan-2026" }]);

    // The customer's own mapping, sent with the request.
    assert.equal((await call("operator", "POST", "/analyse", { ...analyseBody, mappingId: undefined, mapping: { ...mapping, id: "customer-x" } })).status, 200);
    assert.equal(seen[1].mappingId, "customer-x");

    const refused = async (b: unknown, status: number, why: RegExp) => {
      const r = await call("operator", "POST", "/analyse", b);
      assert.equal(r.status, status);
      assert.match(((await r.json()) as { error: string }).error, why);
    };
    await refused({}, 400, /Send/);
    await refused({ ...analyseBody, log: "" }, 400, /empty/);
    await refused({ ...analyseBody, log: "x".repeat(MAX_LOG_BYTES + 1) }, 413, /command line/);
    await refused({ ...analyseBody, mappingId: "nope" }, 422, /unknown mapping "nope"/);
    await refused({ ...analyseBody, mapping: { schema: "other" } }, 422, /mapping can't be used/);
    await refused({ ...analyseBody, eventId: "../../etc/passwd" }, 422, /Unknown replay event/);
    assert.equal(seen.length, 2, "nothing refused reached the runner");
  }, run);
});

test("evidence analyse: a failed run says why without host paths; one run at a time", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const run: PilotRunner = async () => {
    calls += 1;
    if (calls === 1) {
      await gate;
      throw new PilotError("Evidence pack not built: log rows not accounted for");
    }
    throw new Error("/private/var/secret/path exploded");
  };
  await withApi(async (call) => {
    const first = call("operator", "POST", "/analyse", analyseBody);
    await new Promise((r) => setTimeout(r, 50));
    const second = await call("operator", "POST", "/analyse", analyseBody);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "15");
    release();
    const failed = await first;
    assert.equal(failed.status, 422);
    assert.deepEqual(await failed.json(), { error: "Evidence pack not built: log rows not accounted for" });
    const crashed = await call("operator", "POST", "/analyse", analyseBody);
    assert.equal(crashed.status, 500);
    assert.deepEqual(await crashed.json(), { error: "The analysis could not be run" });
  }, run);
});

test("evidence verify: the same lines `npm run trust:verify` prints (GAU-59)", async () => {
  const { pack } = await packFromStoredInputs();
  const dir = mkdtempSync(join(tmpdir(), "gauss-evidence-test-"));
  try {
    writeFileSync(join(dir, "pack.json"), packFileText(pack));
    const tampered = clone(pack);
    tampered.records[0].inference.confidence = 0.01;
    writeFileSync(join(dir, "tampered.json"), packFileText(tampered));
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/trust/verify-pack.ts", ...args], { cwd: REPO_ROOT, encoding: "utf8" });
      // The CLI names the file by the path it was given; the console by its name.
      return { status: r.status, lines: (r.stderr + r.stdout).split("\n").filter(Boolean).map((l) => l.replace(dir + "/", "")) };
    };
    await withApi(async (call) => {
      const route = async (body: unknown) => (await (await call("operator", "POST", "/verify", body)).json()) as { ok: boolean; lines: string[]; problems: string[]; notes: string[] };

      const unsigned = await route({ pack, name: "pack.json" });
      assert.deepEqual(unsigned.lines, ["pack.json: FAILED", `  - ${NOT_SIGNED}`]);
      assert.equal(unsigned.ok, false);
      const cliUnsigned = cli(join(dir, "pack.json"));
      assert.equal(cliUnsigned.status, 1);
      assert.deepEqual(unsigned.lines, cliUnsigned.lines);

      const integrity = await route({ pack, name: "pack.json", allowUnsigned: true });
      assert.equal(integrity.ok, true);
      assert.equal(integrity.lines[0], `pack.json: OK. 3 records, pack hash ${pack.packHash}`);
      assert.match(integrity.lines[1], /^ {2}NOTE: NOT SIGNED: integrity only\./);
      const cliIntegrity = cli(join(dir, "pack.json"), "--allow-unsigned");
      assert.equal(cliIntegrity.status, 0);
      assert.deepEqual([...integrity.lines].sort(), [...cliIntegrity.lines].sort());

      const changed = await route({ pack: tampered, name: "tampered.json", allowUnsigned: true });
      assert.equal(changed.ok, false);
      assert.equal(changed.lines[0], "tampered.json: FAILED");
      assert.ok(changed.problems.some((p) => /was changed: it no longer matches its hash/.test(p)));
      assert.deepEqual([...changed.lines].sort(), [...cli(join(dir, "tampered.json"), "--allow-unsigned").lines].sort());
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence verify: junk is reported as FAILED, never a crash; an odd name falls back to pack.json", async () => {
  await withApi(async (call) => {
    assert.equal((await call("operator", "POST", "/verify", {})).status, 400);
    for (const pack of [{ schema: "nope" }, { schema: "gauss.evidence-pack/0.1", records: [{}], chain: { links: "x" } }, { schema: "gauss.evidence-pack/0.1" }]) {
      const res = await call("operator", "POST", "/verify", { pack, name: "../../etc/passwd", allowUnsigned: true });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; lines: string[] };
      assert.equal(body.ok, false);
      assert.equal(body.lines[0], "pack.json: FAILED");
    }
  });
});

test("evidence pdf: exactly the CLI's rendering; none for a pack that does not verify", async () => {
  const { pack } = await packFromStoredInputs();
  await withApi(async (call) => {
    const res = await call("operator", "POST", "/pdf", { pack });
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="${pack.packId}.pdf"`);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(renderEvidencePdf(pack)));

    const tampered = clone(pack) as EvidencePack;
    tampered.summary.records = 99;
    const refused = await call("operator", "POST", "/pdf", { pack: tampered });
    assert.equal(refused.status, 422);
    assert.match(((await refused.json()) as { problems: string[] }).problems.join("; "), /summary does not match/);
    assert.equal((await call("operator", "POST", "/pdf", {})).status, 400);
  });
});

test("pilot run: the console's pack is the one `trust:ingest --pack` writes, and nothing is left on disk", async () => {
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith("gauss-pilot-"));
  const result = await runPilot({ log: csv, mapping, eventId: "jan-2026" });
  assert.equal(result.summary.accepted, 3);
  assert.deepEqual(result.summary.rejected.map((r) => r.row), [3, 4, 5, 7, 8, 9]);
  assert.equal(result.records.length, 3);
  assert.equal(result.pack.signature, null);
  assert.equal(result.pack.inputs.environment.source, "replay jan-2026");
  assert.equal(result.pack.inputs.log?.fileSha256, result.summary.file.sha256);
  // Sent to the browser and back, it is still the same file, and it checks out.
  const roundTrip = JSON.parse(JSON.stringify(result.pack)) as EvidencePack;
  assert.equal(packFileText(roundTrip), packFileText(result.pack));
  await withApi(async (call) => {
    const check = (await (await call("operator", "POST", "/verify", { pack: roundTrip, allowUnsigned: true })).json()) as { ok: boolean; lines: string[] };
    assert.equal(check.ok, true, check.lines.join("\n"));
  });
  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith("gauss-pilot-")), before);

  await assert.rejects(runPilot({ log: csv, mapping, eventId: "no-such-storm" }), (e: unknown) => e instanceof PilotError && /unknown replay event/.test(e.message));
  await assert.rejects(runPilot({ log: csv, mapping: { ...mapping, schema: "other" } as never, eventId: "jan-2026" }), PilotError);
});
