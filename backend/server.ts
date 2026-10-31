import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import {
  authenticateOptional,
  authenticateRequest,
  authenticateSocket,
  roleSatisfies,
  type AuthContext,
  type AuthRole,
  type AuthenticatedRequest,
} from "./auth.js";
import { CyberTigerDaemon } from "./cybertiger/daemon.js";
import { inferNowcast, triggerTraining } from "./ml-client/client.js";
import {
  getAuroraMap,
  getCanonicalFeed,
  getLatestCanonical,
  getLatestMms,
  getMmsFeed,
  getSourceStatus,
  seedCanonical,
} from "./state.js";
import type {
  CanonicalSpaceWeatherPoint,
  MMSReconVectorPoint,
  IngestionTickResult,
  NowcastInferenceRequest,
} from "./types.js";
import { withFreshness } from "./lib/freshness.js";
import { IngestionWorker } from "./worker/ingest-loop.js";
import { MAX_QUERY_CHARS, memoryQuery, memoryStatus } from "./memory/client.js";
import { worldStateFromFeed } from "./world/build.js";
import { createSwapPlan, rebalanceDeviceNetwork } from "./services/device-swap-manager.js";
import { encodeCanonicalPoint } from "./lib/proto.js";
import { linkGuardian } from "./lib/connectivity.js";
import { bedrock } from "./lib/local-db.js";
import { retentionFromEnv, startTelemetryRetention } from "./lib/telemetry-retention.js";
import { diskFreeBytes, overall, readTpms } from "./lib/tpm.js";
import { SPACE_OBJECT_CATALOG } from "./lib/space-object-catalog.js";
import { auth, CLIENT_IP_HEADER, ssoAllowedDomain, ssoGithubEnabled, ssoGoogleEnabled } from "./better-auth.js";
import { toNodeHandler } from "better-auth/node";
import { SelfHealerAgent } from "./cybertiger/self-healer.js";
import deviceRegistryRouter from "./device-registry.js";
import { createMeshRouters } from "./mesh/router.js";
import { enforceApiPolicy, isPublic } from "./rbac.js";
import { CommerceStore } from "./commerce/store.js";
import { createDataApiRouter, createOrgRouter, createPilotRequestHandler } from "./commerce/routers.js";
import { EnvironmentHistory } from "./trust/environment.js";
import { getL1Structures } from "./adapters/noaa-swpc.js";

const app = express();
const cyberTiger = new CyberTigerDaemon();
const selfHealer = new SelfHealerAgent({ proxyPort: Number(process.env.PROXY_PORT ?? 3001) });

// Forward self-healer events into CyberTiger event stream for HUD visibility
selfHealer.on("heal-event", (evt) => {
  console.log(`[SelfHealer→CyberTiger] ${evt.layer}: ${evt.diagnosis}`);
});

type CyberTigerRequest = AuthenticatedRequest & {
  security?: {
    requestId: string;
    ip: string;
    local?: boolean;
    startedAtMs: number;
    path: string;
    method: string;
  };
};

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use((_req, res, next) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "geolocation=(), microphone=(), camera=()");
  next();
});

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:8080,http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8080")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOriginSet = new Set(allowedOrigins);

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) {
    return true; // Allow requests without Origin header
  }
  // Check if origin is in allowed list
  if (allowedOriginSet.has(origin)) {
    return true;
  }
  // In development, be more permissive
  if (process.env.NODE_ENV !== "production") {
    try {
      return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
  return false;
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(new Error("CORS blocked"));
    },
    credentials: true,
  }),
);

// Better-Auth handler. It rate-limits by CLIENT_IP_HEADER; set it here from the
// address CyberTiger trusts so a client can't pick its own bucket.
app.use("/api/auth", (req, _res, next) => {
  req.headers[CLIENT_IP_HEADER] = cyberTiger.extractClientIp(req);
  next();
});
app.all("/api/auth/*", toNodeHandler(auth));

function withAsyncMiddleware(
  fn: (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => Promise<void>,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req as AuthenticatedRequest, res, next)).catch(next);
  };
}

function parseLookback(value: unknown, fallbackMs: number): number {
  if (typeof value !== "string" || value.length === 0) {
    return fallbackMs;
  }
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(value.trim());
  if (!match) {
    return fallbackMs;
  }
  const h = Number(match[1] ?? 0);
  const m = Number(match[2] ?? 0);
  const s = Number(match[3] ?? 0);
  const total = ((h * 60 + m) * 60 + s) * 1000;
  return total > 0 ? total : fallbackMs;
}

function filterByLookback<T extends { timestamp: string }>(
  points: T[],
  lookbackMs: number,
  limit: number,
): T[] {
  const threshold = Date.now() - lookbackMs;
  const filtered = points.filter((point) => Date.parse(point.timestamp) >= threshold);
  return filtered.slice(Math.max(0, filtered.length - limit));
}

async function fetchCanonicalFromDb(
  lookbackMs: number,
  limit: number,
  accessToken?: string,
): Promise<CanonicalSpaceWeatherPoint[] | null> {
  // Supabase database access has been removed; memory and bedrock are the current sources.
  return null;
}

async function fetchMmsFromDb(
  lookbackMs: number,
  limit: number,
  accessToken?: string,
): Promise<MMSReconVectorPoint[] | null> {
  // Supabase database access has been removed; memory and bedrock are the current sources.
  return null;
}

async function currentTpms() {
  return readTpms({
    pipeline: worker.getPipelineLatency(),
    failedWrites: bedrock.failedWrites,
    diskFreeBytes: await diskFreeBytes(bedrock.dataDir),
    rssBytes: process.memoryUsage().rss,
    sources: getSourceStatus(),
    skill: worker.forecastSkill.skill(),
  });
}

app.get("/health", async (_req, res) => {
  // Public: overall TPM status and the ids of red measures only, no values. GAU-122.
  const tpms = await currentTpms();
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    tpm: { status: overall(tpms), red: tpms.filter((t) => t.status === "red").map((t) => t.id) },
  });
});

app.use("/api", (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const start = Date.now();
  const decision = cyberTiger.inspectRequest(req);
  const tracked = req as CyberTigerRequest;

  tracked.security = {
    requestId: decision.requestId,
    ip: decision.ip,
    local: decision.local,
    startedAtMs: start,
    path: req.originalUrl ?? req.url,
    method: req.method,
  };
  res.setHeader("x-request-id", decision.requestId);

  res.on("finish", () => {
    const detail = tracked.security;
    if (!detail) {
      return;
    }
    cyberTiger.recordResponse({
      requestId: detail.requestId,
      ip: detail.ip,
      local: detail.local,
      method: detail.method,
      path: detail.path,
      status: res.statusCode,
      role: tracked.auth?.role,
      userId: tracked.auth?.userId,
      latencyMs: Date.now() - detail.startedAtMs,
    });
  });

  if (!decision.allowed) {
    res.status(decision.status ?? 429).json({
      error: decision.message ?? "Blocked by CyberTiger",
      requestId: decision.requestId,
    });
    return;
  }

  next();
});
// Tells the login page which sign-in methods to offer (public, no secrets).
app.get("/api/sso-options", (_req, res) => {
  const any = ssoGoogleEnabled || ssoGithubEnabled;
  res.json({ google: ssoGoogleEnabled, github: ssoGithubEnabled, domain: any ? ssoAllowedDomain : null });
});

// Argo agents report with a device token, so this sits before session auth.
const mesh = createMeshRouters();
app.use("/api/mesh", mesh.agent);

// Paid data API: organisation API keys, plans, quotas and metering. Keys, not
// sessions, so this also sits before session auth (backend/commerce/).
const commerce = new CommerceStore(path.resolve(process.env.COMMERCE_DB_PATH ?? "data/commerce/commerce.db"));
app.use(
  "/api/v1",
  createDataApiRouter(commerce, {
    latest: async () => {
      const fromDb = await fetchCanonicalFromDb(5 * 60 * 1000, 1);
      const point = fromDb && fromDb.length > 0 ? fromDb[fromDb.length - 1] : getLatestCanonical();
      return point ? withFreshness(point) : null;
    },
    history: async (lookbackMs, limit) => {
      const fromDb = await fetchCanonicalFromDb(lookbackMs, limit);
      return fromDb ? { source: "database", points: fromDb } : { source: "memory", points: filterByLookback(getCanonicalFeed(), lookbackMs, limit) };
    },
    sources: () => getSourceStatus(),
    // Trust records read the in-memory feed (~28 h at 5 s), longer than any plan's lookback.
    environment: () => new EnvironmentHistory(getCanonicalFeed(), "live feed"),
  }),
);

// Who may call what lives in one table (backend/rbac.ts). Public routes (the
// open landing visualisation) attach a session if present; all others need one.
app.use(
  "/api",
  withAsyncMiddleware((req, res, next) =>
    isPublic(req.method, req.path) ? authenticateOptional(req, res, next) : authenticateRequest(req, res, next),
  ),
);
app.use("/api", enforceApiPolicy);

// Organisation self-service: keys and usage for members (policy: backend/rbac.ts).
app.use("/api/orgs", createOrgRouter(commerce));

// Public "Request a pilot" form on the landing page.
app.post("/api/pilot-requests", createPilotRequestHandler(commerce));

// Mesh & Network page: onboarding for everyone signed in, team status for operators.
app.use("/api/mesh", mesh.ui);

// RAG endpoints: status for any signed-in user, index/query for operators.
// Knowledge memory: the Cosmic Brain sidecar (backend/memory/client.ts, docs/memory-sidecar.md).
// Nothing here is mocked: when the service is down the reply says so, never a canned count or
// answer. Indexing is an operator task on the memory host and has no route here.
app.get("/api/rag/status", async (_req, res) => {
  const status = await memoryStatus();
  if (!status.available) {
    res.status(503).json({ ok: false, error: status.reason });
    return;
  }
  res.json({ ok: true, chunkCount: status.chunks, ...status });
});

app.post("/api/rag/query", async (req: express.Request, res: express.Response) => {
  const { query, topK } = (req.body ?? {}) as { query?: unknown; topK?: unknown };
  if (typeof query !== "string" || !query.trim()) {
    res.status(400).json({ ok: false, error: "Missing query" });
    return;
  }
  if (query.length > MAX_QUERY_CHARS) {
    res.status(400).json({ ok: false, error: `Query longer than ${MAX_QUERY_CHARS} characters` });
    return;
  }
  const result = await memoryQuery(query, typeof topK === "number" ? topK : 8);
  if (!result.available) {
    res.status(503).json({ ok: false, error: result.reason });
    return;
  }
  res.json({ ok: true, answer: result.answer, sources: result.sources });
});

// Device lifecycle endpoints (requires operator session)
app.use("/api/device", deviceRegistryRouter);

app.get("/api/feed/space-weather/5s", async (req: AuthenticatedRequest, res) => {
  const lookbackMs = parseLookback(req.query.lookback, 24 * 60 * 60 * 1000);
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 17280), 17280));
  const token = req.auth?.token;

  const fromDb = await fetchCanonicalFromDb(lookbackMs, limit, token);
  const points = fromDb ?? filterByLookback(getCanonicalFeed(), lookbackMs, limit);

  // LEVEL 4 REDUNDANCY: Bedrock Fallback if both DB and Memory are insufficient
  if (points.length === 0) {
    const local = await bedrock.getRecent(limit);
    const mapped = local.filter(l => l.type === "canonical").map(l => l.data);
    if (mapped.length > 0) {
      res.json({ source: "bedrock", count: mapped.length, points: mapped });
      return;
    }
  }

  res.json({
    source: "memory",
    count: points.length,
    points,
  });
});

app.get("/api/feed/space-weather/latest", async (req: AuthenticatedRequest, res) => {
  const fromDb = await fetchCanonicalFromDb(5 * 60 * 1000, 1, req.auth?.token);
  let point = fromDb && fromDb.length > 0 ? fromDb[fromDb.length - 1] : getLatestCanonical();

  // LEVEL 4 REDUNDANCY: Bedrock Fallback for latest
  if (!point) {
    const local = await bedrock.getRecent(1);
    const mapped = local.filter(l => l.type === "canonical").map(l => l.data as CanonicalSpaceWeatherPoint);
    if (mapped.length > 0) point = mapped[0];
  }

  if (!point) {
    res.status(404).json({ error: "No feed data yet" });
    return;
  }
  res.json(withFreshness(point));
});

app.get("/api/feed/space-objects", (_req, res) => {
  res.json({
    source: "catalog",
    count: SPACE_OBJECT_CATALOG.length,
    objects: SPACE_OBJECT_CATALOG,
  });
});

// 72-hour anomaly forecast: a trained model's output, or an explicit "unavailable"
app.get("/api/forecast/anomaly", async (_req, res) => {
  // Serve the ingest loop's forecast (computed from its last 6 h of measured points every 5 min)
  // instead of calling the model with no data on every request. GAU-115.
  const forecast = worker.getLatestForecast();
  if (forecast) {
    res.json(forecast);
    return;
  }
  res.json({
    available: false,
    modelVersion: null,
    generatedAt: new Date().toISOString(),
    horizonHours: 3,
    reason: "No forecast computed yet; the ingest loop runs one every 5 min.",
  });
});

app.get("/api/feed/space-weather/latest/proto", async (req: AuthenticatedRequest, res) => {
  const fromDb = await fetchCanonicalFromDb(5 * 60 * 1000, 1, req.auth?.token);
  let point = fromDb && fromDb.length > 0 ? fromDb[fromDb.length - 1] : getLatestCanonical();
  
  // Bedrock fallback for proto
  if (!point) {
    const local = await bedrock.getRecent(1);
    const mapped = local.filter(l => l.type === "canonical").map(l => l.data as CanonicalSpaceWeatherPoint);
    if (mapped.length > 0) point = mapped[0];
  }

  if (!point) {
    res.status(404).end();
    return;
  }
  try {
    const buffer = await encodeCanonicalPoint(withFreshness(point));
    res.setHeader("Content-Type", "application/x-protobuf");
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).end();
  }
});

app.get("/api/feed/mms/reconnection", async (req: AuthenticatedRequest, res) => {
  const lookbackMs = parseLookback(req.query.lookback, 2 * 60 * 60 * 1000);
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 1440), 5000));
  const token = req.auth?.token;

  const fromDb = await fetchMmsFromDb(lookbackMs, limit, token);
  const vectors = fromDb ?? filterByLookback(getMmsFeed(), lookbackMs, limit);

  // LEVEL 4 REDUNDANCY: Bedrock Fallback for MMS
  if (vectors.length === 0) {
    const local = await bedrock.getRecent(limit);
    const mapped = local.filter(l => l.type === "mms").map(l => l.data);
    if (mapped.length > 0) {
      res.json({ source: "bedrock", count: mapped.length, vectors: mapped });
      return;
    }
  }

  res.json({
    source: "memory",
    count: vectors.length,
    vectors,
  });
});

app.get("/api/feed/mms/reconnection/latest", async (req: AuthenticatedRequest, res) => {
  const fromDb = await fetchMmsFromDb(30 * 60 * 1000, 1, req.auth?.token);
  let vector = fromDb && fromDb.length > 0 ? fromDb[fromDb.length - 1] : getLatestMms();

  // LEVEL 4 REDUNDANCY: Bedrock Fallback for latest MMS
  if (!vector) {
    const local = await bedrock.getRecent(1);
    const mapped = local.filter(l => l.type === "mms").map(l => l.data as MMSReconVectorPoint);
    if (mapped.length > 0) vector = mapped[0];
  }

  if (!vector) {
    res.status(404).json({ error: "No MMS reconnection data yet" });
    return;
  }
  res.json(vector);
});

app.get("/api/feed/aurora/map", async (req: AuthenticatedRequest, res) => {
  const timestamp = typeof req.query.ts === "string" ? req.query.ts : null;
  const projection = typeof req.query.projection === "string" ? req.query.projection : "gsm";

  const map = getAuroraMap();
  if (!map) {
    res.status(404).json({ error: "No aurora map yet" });
    return;
  }

  res.json({
    projection,
    requestedTimestamp: timestamp,
    ...map,
  });
});

app.get("/api/feed/sources/status", (req: AuthenticatedRequest, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    sources: getSourceStatus(),
    auth: {
      userId: req.auth?.userId ?? null,
      role: req.auth?.role ?? null,
    },
  });
});

app.get("/api/security/cybertiger/status", (_req: AuthenticatedRequest, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    status: cyberTiger.getStatus(),
  });
});

app.get("/api/system/connectivity", (req: AuthenticatedRequest, res) => {
  res.json(linkGuardian.getStatus());
});

// Per-stage ingest latency and the age of the data being served (fresh / degraded / stale / stalled).
app.get("/api/system/pipeline", (_req: AuthenticatedRequest, res) => {
  res.json(worker.getPipelineLatency());
});

// Typed world state (GAU-39): reconstructed read-only from the live feed; never writes back.
app.get("/api/world/state", (_req: AuthenticatedRequest, res) => {
  const { state, observations } = worldStateFromFeed(getCanonicalFeed(), new Date().toISOString());
  const used = new Set(state.observationIds);
  res.json({ state, observations: observations.filter((o) => used.has(o.id)) });
});

// Technical performance measures with thresholds and margins (NASA SE §6.7). GAU-122.
app.get("/api/system/tpm", async (_req: AuthenticatedRequest, res) => {
  const tpms = await currentTpms();
  res.json({ generatedAt: new Date().toISOString(), status: overall(tpms), measures: tpms });
});

// L1 structure candidates over the last 24 h (GAU-139), for the operator console (GAU-154). Before
// the first RTSW fetch there is nothing yet: 200 with null, never an error the UI would retry on.
app.get("/api/swx/structures", (_req: AuthenticatedRequest, res) => {
  const latest = getL1Structures();
  res.json(latest ?? { structures: null, reason: "No L1 data fetched yet" });
});

app.get("/api/security/cybertiger/events", (req: AuthenticatedRequest, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 200), 2000));
  const events = cyberTiger.getEvents(limit);
  res.json({
    timestamp: new Date().toISOString(),
    count: events.length,
    events,
  });
});

app.post("/api/security/cybertiger/block", (req: AuthenticatedRequest, res) => {
  const input = req.body as { ip?: string; reason?: string; seconds?: number };
  const ip = (input.ip ?? "").trim();
  if (!ip) {
    res.status(400).json({ error: "Missing ip" });
    return;
  }
  const reason = (input.reason ?? "manual-admin-action").trim();
  const seconds = Number(input.seconds);
  cyberTiger.blockIp(
    ip,
    reason.length > 0 ? reason : "manual-admin-action",
    Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
    {
      actorRole: req.auth?.role,
      actorUserId: req.auth?.userId,
    },
  );
  res.json({ ok: true, ip, reason, seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null });
});

app.post("/api/security/cybertiger/unblock", (req: AuthenticatedRequest, res) => {
  const input = req.body as { ip?: string };
  const ip = (input.ip ?? "").trim();
  if (!ip) {
    res.status(400).json({ error: "Missing ip" });
    return;
  }
  const removed = cyberTiger.unblockIp(ip, {
    actorRole: req.auth?.role,
    actorUserId: req.auth?.userId,
  });
  res.json({ ok: removed, ip });
});

app.post("/api/ai/nowcast/infer", async (req: AuthenticatedRequest, res) => {
  try {
    const body = req.body as Partial<NowcastInferenceRequest>;
    const sequence = Array.isArray(body.sequence) ? body.sequence : [];
    const horizonMinutes = Math.max(5, Math.min(Number(body.horizonMinutes ?? 60), 180));

    if (sequence.length === 0) {
      const current = getLatestCanonical();
      if (!current) {
        res.status(400).json({ error: "No sequence provided and no live feed available" });
        return;
      }
      const fallbackResponse = await inferNowcast({
        horizonMinutes,
        sequence: [current],
      });
      res.json(fallbackResponse);
      return;
    }

    const response = await inferNowcast({
      horizonMinutes,
      sequence,
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Inference failed" });
  }
});

app.post("/api/ai/nowcast/train", async (_req, res) => {
  try {
    const result = await triggerTraining();
    if (!result.started) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Training trigger failed" });
  }
});

const server = http.createServer(app);

const wsSpaceWeather = new WebSocketServer({ server, path: "/ws/feed/space-weather" });
const wsMmsRecon = new WebSocketServer({ server, path: "/ws/feed/mms-reconnection" });

type AuthedSocket = WebSocket & { auth?: AuthContext };

let broadcastCount = 0;

function broadcast(wss: WebSocketServer, topic: string, payload: unknown): void {
  const link = linkGuardian.getStatus();
  broadcastCount++;

  // Satellite (SAT) Mode Throttling: Only broadcast every 3rd tick (~3s frequency) to save bandwidth
  if (link.mode === "SAT" && broadcastCount % 3 !== 0) {
    return;
  }

  const body = JSON.stringify({ topic, payload, timestamp: new Date().toISOString() });
  for (const client of wss.clients) {
    const socket = client as AuthedSocket;
    if (socket.readyState === 1 && socket.auth) {
      client.send(body);
    }
  }
}

async function guardSocketConnection(
  socket: AuthedSocket,
  requiredRole: AuthRole,
  req: http.IncomingMessage,
): Promise<boolean> {
  const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : null;
  if (!isAllowedOrigin(requestOrigin)) {
    socket.close(1008, "CORS blocked");
    return false;
  }

  const auth = await authenticateSocket(req);
  if (!auth || !roleSatisfies(auth.role, requiredRole)) {
    if (req.socket.remoteAddress) {
      cyberTiger.recordResponse({
        requestId: `ws-${Date.now()}`,
        ip: req.socket.remoteAddress,
        method: "WS",
        path: req.url ?? "/ws",
        status: 403,
      });
    }
    socket.close(1008, "Unauthorized");
    return false;
  }
  socket.auth = auth;
  return true;
}

wsSpaceWeather.on("connection", async (socket: AuthedSocket, req) => {
  const allowed = await guardSocketConnection(socket, "user", req);
  if (!allowed) return;

  socket.send(
    JSON.stringify({
      topic: "system",
      payload: {
        stream: "space-weather",
        message: "Connected",
        role: socket.auth?.role ?? "user",
        timestamp: new Date().toISOString(),
      },
    }),
  );
});

wsMmsRecon.on("connection", async (socket: AuthedSocket, req) => {
  const allowed = await guardSocketConnection(socket, "user", req);
  if (!allowed) return;

  socket.send(
    JSON.stringify({
      topic: "system",
      payload: {
        stream: "mms-reconnection",
        message: "Connected",
        role: socket.auth?.role ?? "user",
        timestamp: new Date().toISOString(),
      },
    }),
  );
});

const worker = new IngestionWorker((result: IngestionTickResult) => {
  if (result.canonicalPoint) {
    broadcast(wsSpaceWeather, "space-weather", result.canonicalPoint);
  }
  if (result.mmsVector) {
    broadcast(wsMmsRecon, "mms-reconnection", result.mmsVector);
  }
});

selfHealer.register({
  onRequestTraining: async () => {
    // The self-healer only needs to know training was requested; log the outcome instead.
    const result = await triggerTraining();
    if (!result.started) console.warn(`[SelfHealer] ${result.message}`);
  },
  onResetIngestion: () => {
    worker.stop();
    worker.start();
  },
});

const swapIntervalMs = Number(process.env.SWAP_BALANCE_INTERVAL_MS ?? 45_000);
let swapInterval: NodeJS.Timeout | null = null;
let stopRetention: (() => void) | null = null;
let backendStarted = false;

export async function startBackend(options?: { host?: string; port?: number }): Promise<{ app: express.Express; server: http.Server; host: string; port: number }> {
  const host = (options?.host ?? ((process.env.PROXY_HOST ?? "127.0.0.1").trim())) || "127.0.0.1";
  const port = options?.port ?? Number(process.env.PROXY_PORT ?? 3001);

  if (server.listening) {
    const address = server.address();
    const actualPort = typeof address === "object" && address?.port ? address.port : port;
    return { app, server, host, port: actualPort };
  }

  // Reload the last 24 h from bedrock so the feed history and the 6 h forecast window survive a
  // restart instead of starting empty. GAU-117.
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const seeded = seedCanonical(await bedrock.getCanonicalSince(since, 20_000));
    if (seeded > 0) console.log(`[backend] reloaded ${seeded} canonical points from bedrock`);
  } catch (error) {
    console.warn("[backend] bedrock reload failed; starting with an empty buffer", error);
  }

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      swapInterval = setInterval(() => {
        const result = rebalanceDeviceNetwork();
        if (result.plan.summary.critical > 0) {
          console.warn("[SwapManager] critical device health detected; rebalance suggested", result.plan.summary);
        }
      }, swapIntervalMs);

      selfHealer.start();
      worker.start();
      // Telemetry retention: 3 days live, every archive kept (Josh 2026-10-29; telemetry-retention.ts).
      stopRetention = startTelemetryRetention(bedrock, retentionFromEnv());

      const address = server.address();
      const actualPort = typeof address === "object" && address?.port ? address.port : port;
      backendStarted = true;
      console.log(`[backend] listening on ${host}:${actualPort}`);
      if (host === "0.0.0.0") {
        console.warn(
          "[backend] warning: PROXY_HOST=0.0.0.0 exposes API on all interfaces. Prefer loopback or Tailscale IP.",
        );
      }
      resolve({ app, server, host, port: actualPort });
    });
    server.on("error", reject);
  });
}

export async function stopBackend(): Promise<void> {
  if (!backendStarted && !server.listening) {
    return;
  }

  worker.stop();
  selfHealer.stop();
  linkGuardian.stop();
  if (swapInterval) {
    clearInterval(swapInterval);
    swapInterval = null;
  }
  stopRetention?.();
  stopRetention = null;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  backendStarted = false;
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[backend] unhandled error", error);
  res.status(500).json({ error: "Internal server error" });
});

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  void startBackend().catch((error) => {
    console.error("[backend] failed to start", error);
    process.exit(1);
  });
}
