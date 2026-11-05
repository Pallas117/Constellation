import express from "express";
import { roleSatisfies, type AuthenticatedRequest } from "../auth.js";
import type { EnvironmentHistory } from "../trust/environment.js";
import { buildTrustRecord, parseTrustRequest, type TrustRecord } from "../trust/record.js";
import { PLANS, type Plan, type PlanLimits } from "./plans.js";
import type { CommerceStore, Org, PilotInterest } from "./store.js";

/** Where the refined data comes from; injected so tests don't need the ingest pipeline. */
export interface DataProvider {
  latest(): Promise<unknown | null>;
  history(lookbackMs: number, limit: number): Promise<{ source: string; points: unknown[] }>;
  sources(): unknown;
  /** The environment history trust records are read from (GAU-57); absent when not offered. */
  environment?(): EnvironmentHistory | null;
}

/** Inferences per trust-record request. */
export const MAX_TRUST_BATCH = 100;

type KeyedRequest = express.Request & { apiKey?: { keyId: string; org: Org } };

const MAX_POINTS = 17_280; // 24h at 5s cadence

/** ISO-8601 durations like PT6H / PT30M / P1D. */
function parseLookback(value: unknown, fallbackMs: number): number {
  if (typeof value !== "string") return fallbackMs;
  const m = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!m || value === "P" || value === "PT") return fallbackMs;
  const [, d, h, min] = m.map((x) => Number(x ?? 0));
  return ((d * 24 + h) * 60 + min) * 60 * 1000 || fallbackMs;
}

/**
 * Paid machine API at /api/v1, authenticated only by an organisation API key
 * (`Authorization: Bearer gk_…`). Mounted before session auth. Enforces the
 * organisation's plan, a per-key per-minute limit and a per-org daily quota,
 * and meters every successful call for invoicing.
 */
export function createDataApiRouter(
  store: CommerceStore,
  data: DataProvider,
  now: () => Date = () => new Date(),
  plans: Readonly<Record<Plan, PlanLimits>> = PLANS,
) {
  const router = express.Router();
  const minuteWindows = new Map<string, { start: number; count: number }>();

  router.use((req: KeyedRequest, res, next) => {
    const header = req.header("authorization") ?? "";
    const raw = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const resolved = raw ? store.resolveKey(raw) : undefined;
    if (!resolved) {
      res.status(401).json({ error: "Valid API key required (Authorization: Bearer gk_…)" });
      return;
    }
    const limits = plans[resolved.org.plan];
    if (!limits.api) {
      res.status(403).json({ error: `The ${resolved.org.plan} plan does not include API access` });
      return;
    }

    const t = now();
    const window = minuteWindows.get(resolved.keyId);
    if (!window || t.getTime() - window.start >= 60_000) {
      minuteWindows.set(resolved.keyId, { start: t.getTime(), count: 1 });
    } else if (++window.count > limits.requestsPerMinute) {
      res.setHeader("Retry-After", String(Math.ceil((window.start + 60_000 - t.getTime()) / 1000)));
      res.status(429).json({ error: `Rate limit: ${limits.requestsPerMinute} requests per minute per key` });
      return;
    }

    const usedToday = store.orgUsageOn(resolved.org.id, t.toISOString().slice(0, 10));
    if (usedToday >= limits.requestsPerDay) {
      res.status(429).json({ error: `Daily quota of ${limits.requestsPerDay} requests reached for this organisation` });
      return;
    }
    res.setHeader("X-Quota-Limit", String(limits.requestsPerDay));
    res.setHeader("X-Quota-Remaining", String(limits.requestsPerDay - usedToday - 1));

    req.apiKey = resolved;
    // Meter only calls that succeeded, by route template (never raw query strings).
    res.on("finish", () => {
      if (res.statusCode < 400) store.recordUse(resolved.keyId, `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`, t);
    });
    next();
  });

  const meta = (req: KeyedRequest) => ({ org: req.apiKey!.org.name, plan: req.apiKey!.org.plan, generatedAt: now().toISOString() });

  router.get("/data/space-weather/latest", async (req: KeyedRequest, res) => {
    const point = await data.latest();
    if (!point) {
      res.status(404).json({ error: "No data yet" });
      return;
    }
    res.json({ data: point, meta: meta(req) });
  });

  router.get("/data/space-weather/history", async (req: KeyedRequest, res) => {
    const maxLookback = plans[req.apiKey!.org.plan].maxLookbackMs;
    const lookbackMs = Math.min(parseLookback(req.query.lookback, 60 * 60 * 1000), maxLookback);
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 720) || 720, MAX_POINTS));
    const { source, points } = await data.history(lookbackMs, limit);
    res.json({ data: points, meta: { ...meta(req), source, lookbackMs, count: points.length } });
  });

  router.get("/data/sources/status", (req: KeyedRequest, res) => {
    res.json({ data: data.sources(), meta: meta(req) });
  });

  /**
   * PR-01 trust records (GAU-57): one inference, or {"inferences": [...]} up to MAX_TRUST_BATCH.
   * Each item is validated on its own; an invalid one is returned with its errors, never
   * guessed. Inference times beyond the plan's lookback are refused here: older windows are a
   * replay pilot (PR-03), not a live lookup. Every record returned is logged for invoicing
   * (GAU-70) before the response goes out; if that log can't be written, nothing is returned.
   */
  router.post("/data/trust/records", (req: KeyedRequest, res) => {
    const history = data.environment?.() ?? null;
    if (!history) {
      res.status(503).json({ error: "Trust records are not available on this server" });
      return;
    }
    const body: unknown = req.body;
    const batch = body && typeof body === "object" && !Array.isArray(body) && "inferences" in body;
    const items: unknown[] = batch ? ((body as { inferences: unknown }).inferences as unknown[]) : [body];
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_TRUST_BATCH) {
      res.status(400).json({ error: `Send one inference, or {"inferences": [...]} with 1 to ${MAX_TRUST_BATCH} items` });
      return;
    }
    const nowMs = now().getTime();
    const oldest = nowMs - plans[req.apiKey!.org.plan].maxLookbackMs;
    const records: TrustRecord[] = [];
    const rejected: Array<{ index: number; errors: string[] }> = [];
    items.forEach((item, index) => {
      const parsed = parseTrustRequest(item);
      if ("errors" in parsed) {
        rejected.push({ index, errors: parsed.errors });
      } else if (Date.parse(parsed.request.time) < oldest) {
        rejected.push({ index, errors: ["time is older than this plan's lookback; older windows are covered by a replay pilot"] });
      } else {
        records.push(buildTrustRecord(parsed.request, history, { nowMs }));
      }
    });
    if (!batch && rejected.length) {
      res.status(400).json({ error: "Invalid inference", errors: rejected[0].errors });
      return;
    }
    try {
      store.recordTrustIssued(
        req.apiKey!.keyId,
        records.map((r) => ({ recordId: r.recordId, spacecraftId: r.inference.spacecraftId })),
        now(),
      );
    } catch (err) {
      console.error("[trust] usage log write failed; no records returned:", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "Could not record usage; no records were issued. Please retry." });
      return;
    }
    if (!batch) res.json({ data: records[0], meta: meta(req) });
    else res.json({ data: records, rejected, meta: { ...meta(req), count: records.length } });
  });

  return router;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const INTERESTS = new Set(["data-api", "connectivity", "both"]);

/**
 * Public "Request a pilot" endpoint behind the landing page's pilot panels.
 * Abuse limits: 3 requests per IP per hour, a hidden honeypot field, length
 * caps. Leads are stored for admins (`npm run org -- leads`); nothing is sent
 * anywhere automatically.
 */
export function createPilotRequestHandler(store: CommerceStore, now: () => number = Date.now) {
  const recent = new Map<string, number[]>();
  return (req: express.Request, res: express.Response) => {
    const ip = req.ip ?? "unknown";
    const hourAgo = now() - 60 * 60 * 1000;
    const times = (recent.get(ip) ?? []).filter((t) => t > hourAgo);
    if (times.length >= 3) {
      res.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    // Bots fill every field; people never see this one. Pretend success.
    if (text(b.website, 200)) {
      res.status(201).json({ ok: true });
      return;
    }
    const lead = {
      name: text(b.name, 120),
      email: text(b.email, 254).toLowerCase(),
      company: text(b.company, 160),
      interest: (INTERESTS.has(String(b.interest)) ? b.interest : "both") as PilotInterest,
      useCase: text(b.useCase, 2000),
    };
    if (!lead.name || !lead.company || !EMAIL_RE.test(lead.email)) {
      res.status(400).json({ error: "Name, a valid work email and company are required." });
      return;
    }
    times.push(now());
    recent.set(ip, times);
    store.addPilotRequest(lead, ip);
    res.status(201).json({ ok: true });
  };
}

/**
 * Session-authenticated organisation self-service at /api/orgs (after the RBAC
 * policy). Members manage their organisation's keys and see its usage;
 * operators may read any organisation's usage. Creating organisations,
 * changing plans and adding members is done by admins with `npm run org`.
 */
export function createOrgRouter(store: CommerceStore) {
  const router = express.Router();
  const canSee = (req: AuthenticatedRequest, orgId: string) =>
    store.isMember(orgId, req.auth!.userId) || roleSatisfies(req.auth!.role, "operator");

  router.get("/mine", (req: AuthenticatedRequest, res) => {
    const orgs = store.orgsFor(req.auth!.userId).map((org) => ({
      ...org,
      limits: PLANS[org.plan],
      keys: store.listKeys(org.id),
    }));
    res.json({ orgs });
  });

  router.post("/:orgId/keys", (req: AuthenticatedRequest, res) => {
    const orgId = String(req.params.orgId);
    // Only members create keys; anyone else sees "not found" so org ids can't be probed.
    const org = store.isMember(orgId, req.auth!.userId) ? store.getOrg(orgId) : undefined;
    if (!org) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    if (!PLANS[org.plan].api) {
      res.status(403).json({ error: `The ${org.plan} plan does not include API access` });
      return;
    }
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const { key, info } = store.createKey(org.id, name, req.auth!.userId);
    res.status(201).json({ key, info, note: "Shown once. Store it in your secret manager; Gauss keeps only a hash." });
  });

  router.delete("/:orgId/keys/:keyId", (req: AuthenticatedRequest, res) => {
    const orgId = String(req.params.orgId);
    if (!store.isMember(orgId, req.auth!.userId)) {
      res.status(404).end();
      return;
    }
    res.status(store.revokeKey(orgId, String(req.params.keyId)) ? 204 : 404).end();
  });

  router.get("/:orgId/usage", (req: AuthenticatedRequest, res) => {
    const orgId = String(req.params.orgId);
    if (!canSee(req, orgId) || !store.getOrg(orgId)) {
      res.status(404).json({ error: "Organisation not found" });
      return;
    }
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const today = new Date().toISOString().slice(0, 10);
    const from = typeof req.query.from === "string" && day.test(req.query.from) ? req.query.from : `${today.slice(0, 8)}01`;
    const to = typeof req.query.to === "string" && day.test(req.query.to) ? req.query.to : today;
    const rows = store.usage(orgId, from, to);
    res.json({ from, to, total: rows.reduce((n, r) => n + r.count, 0), rows });
  });

  return router;
}
