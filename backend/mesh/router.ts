import express from "express";
import path from "node:path";
import { requireRole, type AuthenticatedRequest } from "../auth.js";
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
    { id: "tailscale", title: "Install Tailscale and join the tailnet", command: "brew install --cask tailscale", detail: "Sign in with your Lightbound account, then ask an admin to approve the device." },
    { id: "argo", title: "Build and install Argo", command: "cd tools/argo && go build -o ~/.local/bin/argo . && argo install", detail: "argo install only writes the LaunchAgent plist; it prints the launchctl command for you to run." },
    { id: "enroll", title: "Connect Argo to Gauss", command: "argo enroll <gauss-tailnet-url> <device-name>", detail: "An admin creates the device token on this page. Paste it when prompted; it is never put on the command line." },
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

  /** Mounted after session auth. Team network state is operator-only. */
  const ui = express.Router();
  ui.get("/onboarding", (_req, res) => {
    res.json({ ok: true, steps: onboardingSteps() });
  });
  ui.get("/devices", requireRole("operator"), (_req, res) => {
    res.json({ ok: true, devices: store.list() });
  });
  ui.post("/devices", requireRole("admin"), (req: AuthenticatedRequest, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().toLowerCase() : "";
    const result = store.enroll(name, req.auth!.userId);
    if ("error" in result) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.status(201).json({ ok: true, name: result.device.name, token: result.token, note: "Shown once. Paste it into `argo enroll`." });
  });
  ui.delete("/devices/:name", requireRole("admin"), (req, res) => {
    res.status(store.revoke(String(req.params.name)) ? 204 : 404).end();
  });

  return { agent, ui };
}
