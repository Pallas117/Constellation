/**
 * End-to-end check of Argo store-and-forward (GAU-193) with the real pieces:
 * the argo binary built from tools/argo, run as two devices with their own
 * HOME, against the real Gauss mesh routers (backend/mesh) over HTTP on
 * 127.0.0.1. Nothing touches the live services, the tailnet or your real
 * ~/.config/argo: everything lives in a temp dir that is deleted at the end.
 *
 *   npx tsx scripts/argo-relay-e2e.ts        (needs Go; 1-3 min: `argo enroll` runs the real network probes)
 *
 * Steps, as a customer would meet them: enroll two devices, send a file,
 * the hub goes down, send another while it is down, the hub comes back,
 * the receiver collects both, receipts confirm both, a tampered bundle is
 * refused, a carried drive delivers only what hadn't arrived (including the
 * genuine copy of the tampered one), fingerprints match /mesh.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../backend/auth.js";
import { BundleStore } from "../backend/mesh/bundles.js";
import { createMeshRouters } from "../backend/mesh/router.js";
import { MeshStore } from "../backend/mesh/store.js";

const root = mkdtempSync(path.join(os.tmpdir(), "argo-e2e-"));
const argo = path.join(root, "argo");
let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${ok || !detail ? "" : `\n      ${detail.trim().split("\n").join("\n      ")}`}`);
  if (!ok) failures++;
};

function startHub(port = 0): Promise<Server> {
  const mesh = createMeshRouters(new MeshStore(path.join(root, "hub", "devices.json")), new BundleStore(path.join(root, "hub", "bundles")));
  const app = express();
  app.use(express.json());
  app.use("/api/mesh", mesh.agent);
  app.use("/api", (req: AuthenticatedRequest, _res, next) => {
    // Stand-in for the session: the e2e operator is staff (enrolls) or operator (sees /mesh).
    const role = req.header("x-test-role") as AuthRole | undefined;
    if (role) req.auth = { userId: "u-e2e", email: null, role, rawRoles: [role], token: "t" };
    next();
  });
  app.use("/api/mesh", mesh.ui);
  return new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
}

// Async on purpose: the hub runs in this process, so a blocking spawn would
// stop it answering while argo waits for it.
function run(home: string, args: string[], input?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(argo, args, { env: { PATH: process.env.PATH, HOME: home, ARGO_NO_DESKTOP: "1" } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (process.env.E2E_VERBOSE) console.log(`  $ argo ${args.join(" ")} (HOME=${path.basename(home)})\n${out.replace(/^/gm, "    ")}`);
      resolve({ code: code ?? -1, out });
    });
    child.stdin.end(input ?? "");
  });
}

async function main() {
  execFileSync("go", ["build", "-trimpath", "-o", argo, "."], { cwd: path.resolve("tools/argo"), stdio: "inherit" });
  let hub = await startHub();
  const port = (hub.address() as AddressInfo).port;
  const gauss = `http://127.0.0.1:${port}`;
  const api = `${gauss}/api/mesh`;
  const homes = { alpha: path.join(root, "alpha"), bravo: path.join(root, "bravo") };

  // 1. Onboarding: a staff member enrolls each device on /mesh and pastes the token into `argo enroll`.
  for (const [name, home] of Object.entries(homes)) {
    mkdirSync(home, { recursive: true });
    const res = await fetch(`${api}/devices`, { method: "POST", headers: { "content-type": "application/json", "x-test-role": "staff" }, body: JSON.stringify({ name: `e2e-${name}` }) });
    const { token } = (await res.json()) as { token: string };
    const r = await run(home, ["enroll", gauss, `e2e-${name}`], `${token}\n`);
    check(/key fingerprint/.test(r.out), `enroll e2e-${name} creates keys and publishes them`, r.out);
  }
  const dir = (await (await fetch(`${api}/devices`, { headers: { "x-test-role": "operator" } })).json()) as { devices: Array<{ name: string; keyFingerprint?: string }> };
  check(dir.devices.every((d) => d.keyFingerprint), "both devices show a key fingerprint on /mesh", JSON.stringify(dir));

  if (process.env.E2E_VERBOSE) {
    await run(homes.alpha, ["keys", "list"]);
    await run(homes.alpha, ["sync"]);
    await run(homes.alpha, ["keys", "list"]);
  }
  // 2. Send while the hub is up.
  const one = path.join(root, "pass-plan.csv");
  writeFileSync(one, "aos,los,max_el\n09:41,09:52,62\n");
  let r = await run(homes.alpha, ["send", "e2e-bravo", one]);
  check(/queued pass-plan\.csv/.test(r.out) && /sent 1/.test(r.out), "send uploads to the hub", r.out);

  // 3. The hub goes down; a send still queues; the hub comes back and the queue drains.
  await new Promise((done) => hub.close(done));
  const two = path.join(root, "ephemeris.bin");
  writeFileSync(two, Buffer.alloc(2 * 1024 * 1024 + 4321, 7)); // three chunks
  r = await run(homes.alpha, ["send", "e2e-bravo", two]);
  check(/queued ephemeris\.bin/.test(r.out) && /hub unreachable/.test(r.out), "a send while the hub is down queues instead of failing", r.out);
  hub = await startHub(port);
  // The first upload attempt failed, so the retry is backed off ~30 s; wait it out like a tick would.
  await new Promise((done) => setTimeout(done, 31_000));
  r = await run(homes.alpha, ["sync"]);
  check(/sent 3/.test(r.out), "after the outage the queued chunks upload", r.out);

  // 4. The receiver collects both files, byte for byte.
  r = await run(homes.bravo, ["sync"]);
  const inbox = path.join(homes.bravo, "Downloads", "Argo", "e2e-alpha");
  const got = readdirSync(inbox).sort();
  check(got.join(",") === "ephemeris.bin,pass-plan.csv", "the receiver has both files", `${r.out}\n${got}`);
  check(readFileSync(path.join(inbox, "ephemeris.bin")).equals(readFileSync(two)) && readFileSync(path.join(inbox, "pass-plan.csv"), "utf8") === readFileSync(one, "utf8"), "contents match exactly");

  // 5. Signed receipts confirm both to the sender.
  await run(homes.bravo, ["sync"]);
  await run(homes.alpha, ["sync"]);
  r = await run(homes.alpha, ["outbox"]);
  check(/pass-plan\.csv → e2e-bravo: 1\/1 confirmed/.test(r.out) && /ephemeris\.bin → e2e-bravo: 3\/3 confirmed/.test(r.out), "the sender sees both confirmed", r.out);

  // 6. A bundle altered at the hub is refused and never reaches the inbox.
  const evil = path.join(root, "orders.txt");
  writeFileSync(evil, "genuine");
  await run(homes.alpha, ["send", "e2e-bravo", evil]);
  const box = path.join(root, "hub", "bundles", "e2e-bravo");
  for (const f of readdirSync(box)) {
    const b = readFileSync(path.join(box, f));
    b[b.length - 40] ^= 0x01; // inside the ciphertext; the block CRC no longer matches either
    writeFileSync(path.join(box, f), b);
  }
  r = await run(homes.bravo, ["sync"]);
  check(/refused 1/.test(r.out) && !readdirSync(inbox).includes("orders.txt"), "a tampered bundle is refused", r.out);

  // 7. A carried drive: what already arrived isn't delivered twice, and the genuine copy of the
  //    bundle that was tampered with at the hub still gets through (a refused copy doesn't burn its id).
  const drive = path.join(root, "drive");
  await run(homes.alpha, ["mule", "export", drive]);
  r = await run(homes.bravo, ["mule", "import", drive]);
  const after = readdirSync(inbox).sort();
  check(/received 1/.test(r.out) && after.join(",") === "ephemeris.bin,orders.txt,pass-plan.csv", "a drive delivers only what hadn't arrived", `${r.out}\n${after}`);
  check(readFileSync(path.join(inbox, "orders.txt"), "utf8") === "genuine", "the genuine copy arrives after the tampered one was refused");

  // 8. What alpha trusts for bravo is what /mesh shows for bravo.
  r = await run(homes.alpha, ["keys", "list"]);
  const bravoFp = dir.devices.find((d) => d.name === "e2e-bravo")?.keyFingerprint ?? "?";
  check(r.out.includes(bravoFp), "alpha pins the same key /mesh shows for bravo", r.out);

  await new Promise((done) => hub.close(done));
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
  });
