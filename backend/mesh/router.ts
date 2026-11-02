import express from "express";
import path from "node:path";
import { requireRole, roleSatisfies, type AuthenticatedRequest } from "../auth.js";
import { BUNDLE_ID_RE, BundleStore, MAX_BUNDLE_BYTES, parseKeys } from "./bundles.js";
import { MeshStore, parseReport, type MeshDevice } from "./store.js";

const ALLOWED_EXIT_COUNTRIES = new Set(["MY", "SG"]);
const MIN_REPORT_INTERVAL_MS = 10_000;
const BUNDLE_UPLOADS_PER_MINUTE = 120;
const MAX_STATUS_IDS = 512;

/** MESH_EXIT_NODES="exit-sg-1:SG,exit-my-1:MY"; anything outside MY/SG is ignored. */
export function exitNodesFromEnv(raw = process.env.MESH_EXIT_NODES ?? "") {
  return raw
    .split(",")
    .map((entry) => entry.trim().split(":"))
    .filter(([name, cc]) => name && ALLOWED_EXIT_COUNTRIES.has((cc ?? "").toUpperCase()))
    .map(([name, cc]) => ({ name, country: cc.toUpperCase() }));
}

export function onboardingSteps(exitNodes = exitNodesFromEnv()) {
  return [
    { id: "tailscale", title: "Install Tailscale and join the tailnet", command: "brew install --cask tailscale", detail: "Open Tailscale and sign in with your Lightbound Google Workspace account; an admin approves new devices in the Tailscale admin console." },
    { id: "argo", title: "Build and install Argo", command: "cd tools/argo && go build -o ~/.local/bin/argo . && argo install", detail: "argo install only writes the LaunchAgent plist; it prints the launchctl command for you to run." },
    { id: "enroll", title: "Connect Argo to Gauss", command: "argo enroll <gauss-tailnet-url> <device-name>", detail: "Create a device token on this page (Enroll a device). Paste it when prompted; it is never put on the command line. Argo sends a first report straight away and says whether Gauss accepted it." },
    { id: "verify", title: "Check your exit country", command: "argo doctor", detail: "class must be OK and loc must be MY or SG. A Hong Kong eSIM shows REGION: switch to a Malaysian SIM." },
    { id: "guard", title: "See what this device can take on", command: "argo guard", detail: "Memory, battery, disk and CPU now and over the last day, and what to fix first. A new device takes mesh work after 10 calm minutes; on battery it takes light work only. The Can host column shows the same reasons." },
    {
      id: "exit-node",
      title: "Use the MY/SG exit node when a network blocks you",
      command: exitNodes[0] ? `tailscale set --exit-node=${exitNodes[0].name}` : null,
      detail: exitNodes.length
        ? `Approved exit nodes: ${exitNodes.map((n) => `${n.name} (${n.country})`).join(", ")}. Add them to ~/.config/argo/config.json under exit_nodes.`
        : "Pending: no MY/SG exit node is deployed yet.",
      pending: exitNodes.length === 0,
    },
    { id: "stale-daemon", title: "If Claude agents fail with ECONNREFUSED", command: "claude daemon stop --any", detail: "A background daemon can keep a dead proxy from an old shell. Argo reports this as STALE_DAEMON." },
    {
      id: "relay",
      title: "Send files that survive drop-outs",
      command: "argo send <device> <file>",
      detail:
        "Signed and end-to-end encrypted (HPKE); Gauss holds only ciphertext until the other device collects it, and you get a signed receipt. Devices enrolled before this step run `argo keys` once. Compare fingerprints (`argo keys list`) with the owner before trusting a device.",
    },
  ];
}

function bearer(req: express.Request): string | null {
  const h = req.header("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() || null : null;
}

export function createMeshRouters(
  store = new MeshStore(path.resolve(process.env.MESH_STORE_PATH ?? "data/mesh/devices.json")),
  bundles = new BundleStore(path.resolve(process.env.MESH_BUNDLE_PATH ?? "data/mesh/bundles")),
) {
  /** Mounted before session auth: Argo agents authenticate with a device token. */
  const agent = express.Router();

  /** The enrolled device behind the bearer token, or a 401 already sent. */
  const deviceFor = (req: express.Request, res: express.Response): MeshDevice | undefined => {
    const token = bearer(req);
    const device = token ? store.byToken(token) : undefined;
    if (!device) res.status(401).json({ ok: false, error: "Unknown device token" });
    return device;
  };

  agent.post("/report", (req, res) => {
    const device = deviceFor(req, res);
    if (!device) return;
    const last = device.last ? Date.parse(device.last.receivedAt) : 0;
    if (Date.now() - last < MIN_REPORT_INTERVAL_MS) {
      res.status(429).json({ ok: false, error: "Reporting too often" });
      return;
    }
    const report = parseReport(req.body);
    if (!report) {
      store.reject(device); // the page shows it, instead of "Never reported" with no reason
      res.status(400).json({ ok: false, error: "Invalid report" });
      return;
    }
    store.record(device, report);
    res.json({ ok: true });
  });

  // ---- store-and-forward relay (bundles.ts): ciphertext and public keys only ----

  const uploads = new Map<string, number[]>(); // device → upload times in the last minute
  agent.post("/bundles", express.raw({ type: "application/octet-stream", limit: MAX_BUNDLE_BYTES }), (req, res) => {
    const device = deviceFor(req, res);
    if (!device) return;
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ ok: false, error: "Send the bundle as application/octet-stream" });
      return;
    }
    const now = Date.now();
    const recent = (uploads.get(device.name) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= BUNDLE_UPLOADS_PER_MINUTE) {
      res.status(429).json({ ok: false, error: "Uploading too often" });
      return;
    }
    uploads.set(device.name, [...recent, now]);
    const result = bundles.put(device.name, req.body, (name) => store.has(name));
    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error });
      return;
    }
    res.status(result.status).json({ ok: true, id: result.id, duplicate: result.duplicate });
  });
  agent.get("/bundles", (req, res) => {
    const device = deviceFor(req, res);
    if (!device) return;
    res.json({ ok: true, bundles: bundles.list(device.name).map(({ id, from, size, receivedAt, expiresAt }) => ({ id, from, size, receivedAt, expiresAt })) });
  });
  // Before /bundles/:id so "status" is never read as an id.
  agent.post("/bundles/status", (req, res) => {
    const device = deviceFor(req, res);
    if (!device) return;
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]) : null;
    if (!ids || ids.length > MAX_STATUS_IDS || !ids.every((id) => typeof id === "string" && BUNDLE_ID_RE.test(id))) {
      res.status(400).json({ ok: false, error: `ids must be up to ${MAX_STATUS_IDS} bundle ids` });
      return;
    }
    res.json({ ok: true, status: bundles.status(device.name, ids as string[]) });
  });
  agent.get("/bundles/:id", (req, res) => {
    const device = deviceFor(req, res);
    if (!device) return;
    const raw = BUNDLE_ID_RE.test(req.params.id) ? bundles.get(device.name, req.params.id) : null;
    if (!raw) {
      res.status(404).json({ ok: false, error: "No such bundle for this device" });
      return;
    }
    res.type("application/octet-stream").send(raw);
  });
  agent.delete("/bundles/:id", (req, res) => {
    const device = deviceFor(req, res);
    if (!device) return;
    if (!BUNDLE_ID_RE.test(req.params.id) || !bundles.ack(device.name, req.params.id)) {
      res.status(404).json({ ok: false, error: "No such bundle for this device" });
      return;
    }
    res.status(204).end();
  });
  agent.get("/directory", (req, res) => {
    if (!deviceFor(req, res)) return;
    res.json({ ok: true, keys: store.directory() });
  });
  agent.post("/keys", (req, res) => {
    const device = deviceFor(req, res);
    if (!device) return;
    const keys = parseKeys(req.body);
    if (!keys || (req.body.node !== undefined && req.body.node !== device.name)) {
      res.status(400).json({ ok: false, error: "Invalid keys" });
      return;
    }
    const result = store.setKeys(device, keys);
    if (result === "conflict") {
      res.status(409).json({ ok: false, error: "This device already published different keys; revoke and re-enroll it to replace them" });
      return;
    }
    res.status(result === "created" ? 201 : 200).json({ ok: true });
  });

  /**
   * Mounted after session auth. staff+ onboard and manage their own devices;
   * operator+ see the whole team; admin can revoke any device. The page only
   * calls routes the role allows (onboarding says which), because every 403
   * counts as an auth failure in CyberTiger and polling one would auto-block
   * the caller's IP.
   */
  const ui = express.Router();
  const isAdmin = (req: AuthenticatedRequest) => (req.auth ? roleSatisfies(req.auth.role, "admin") : false);
  const isOperator = (req: AuthenticatedRequest) => (req.auth ? roleSatisfies(req.auth.role, "operator") : false);

  ui.get("/onboarding", requireRole("staff"), (req: AuthenticatedRequest, res) => {
    res.json({
      ok: true,
      steps: onboardingSteps(),
      me: req.auth!.userId,
      canEnroll: true,
      canSeeTeam: isOperator(req),
      canRevokeAny: isAdmin(req),
    });
  });
  ui.get("/devices", requireRole("staff"), (req: AuthenticatedRequest, res) => {
    bundles.sweep();
    const waiting = bundles.queueStats(); // counts and sizes only: never who sent what
    const devices = store.list().map((d) => ({ ...d, relay: waiting.get(d.name) ?? { queued: 0, bytes: 0 } }));
    res.json({ ok: true, devices: isOperator(req) ? devices : devices.filter((d) => d.owner === req.auth!.userId) });
  });
  ui.post("/devices", requireRole("staff"), (req: AuthenticatedRequest, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().toLowerCase() : "";
    const result = store.enroll(name, req.auth!.userId);
    if ("error" in result) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.status(201).json({ ok: true, name: result.device.name, token: result.token, note: "Shown once. Paste it into `argo enroll`." });
  });
  ui.delete("/devices/:name", requireRole("staff"), (req: AuthenticatedRequest, res) => {
    const name = String(req.params.name);
    const device = store.list().find((d) => d.name === name);
    // Someone else's device looks the same as a missing one, so names can't be probed.
    if (!device || (device.owner !== req.auth!.userId && !isAdmin(req))) {
      res.status(404).end();
      return;
    }
    store.revoke(name);
    bundles.purge(name);
    uploads.delete(name); // its upload-rate window goes too (GAU-208)
    res.status(204).end();
  });

  return { agent, ui };
}
