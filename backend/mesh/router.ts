import express from "express";
import path from "node:path";
import { requireRole, roleSatisfies, type AuthenticatedRequest } from "../auth.js";
import { MeshStore, parseReport } from "./store.js";

const ALLOWED_EXIT_COUNTRIES = new Set(["MY", "SG"]);
const MIN_REPORT_INTERVAL_MS = 10_000;

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
    { id: "enroll", title: "Connect Argo to Gauss", command: "argo enroll <gauss-tailnet-url> <device-name>", detail: "Create a device token on this page (Enroll this laptop). Paste it when prompted; it is never put on the command line." },
    { id: "verify", title: "Check your exit country", command: "argo doctor", detail: "class must be OK and loc must be MY or SG. A Hong Kong eSIM shows REGION: switch to a Malaysian SIM." },
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
  ];
}

function bearer(req: express.Request): string | null {
  const h = req.header("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() || null : null;
}

export function createMeshRouters(store = new MeshStore(path.resolve(process.env.MESH_STORE_PATH ?? "data/mesh/devices.json"))) {
  /** Mounted before session auth: Argo agents authenticate with a device token. */
  const agent = express.Router();
  agent.post("/report", (req, res) => {
    const token = bearer(req);
    const device = token ? store.byToken(token) : undefined;
    if (!device) {
      res.status(401).json({ ok: false, error: "Unknown device token" });
      return;
    }
    const last = device.last ? Date.parse(device.last.receivedAt) : 0;
    if (Date.now() - last < MIN_REPORT_INTERVAL_MS) {
      res.status(429).json({ ok: false, error: "Reporting too often" });
      return;
    }
    const report = parseReport(req.body);
    if (!report) {
      res.status(400).json({ ok: false, error: "Invalid report" });
      return;
    }
    store.record(device, report);
    res.json({ ok: true });
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
    const devices = store.list();
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
    res.status(204).end();
  });

  return { agent, ui };
}
