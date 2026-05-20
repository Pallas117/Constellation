import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { AuthRole } from "../auth.js";

export type CyberTigerSeverity = "info" | "low" | "medium" | "high" | "critical";

export type CyberTigerEventType =
  | "request.allow"
  | "request.rate_limit"
  | "request.signature"
  | "request.blocked_ip"
  | "auth.failure"
  | "auth.failure_threshold"
  | "http.error"
  | "ip.blocked"
  | "ip.unblocked";

export interface CyberTigerEvent {
  id: string;
  timestamp: string;
  type: CyberTigerEventType;
  severity: CyberTigerSeverity;
  ip: string;
  method?: string;
  path?: string;
  status?: number;
  requestId?: string;
  message: string;
  actorUserId?: string;
  actorRole?: AuthRole;
  metadata?: Record<string, unknown>;
}

interface RateBucket {
  windowStartMs: number;
  count: number;
}

interface AuthFailureWindow {
  windowStartMs: number;
  failures: number;
}

interface BlockRecord {
  untilMs: number;
  reason: string;
}

export interface CyberTigerInspectDecision {
  allowed: boolean;
  requestId: string;
  ip: string;
  status?: number;
  message?: string;
}

export interface CyberTigerRecordResponseInput {
  requestId: string;
  ip: string;
  method: string;
  path: string;
  status: number;
  role?: AuthRole;
  userId?: string;
  latencyMs?: number;
}

export interface CyberTigerConfig {
  enabled: boolean;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  authFailureWindowMs: number;
  authFailureThreshold: number;
  autoBlockSeconds: number;
  maxEvents: number;
}

export interface CyberTigerStatus {
  enabled: boolean;
  config: CyberTigerConfig;
  counters: {
    totalInspected: number;
    blocked: number;
    signatureHits: number;
    rateLimited: number;
    authFailures: number;
    activeBlocks: number;
    storedEvents: number;
  };
  activeBlocks: Array<{
    ip: string;
    until: string;
    reason: string;
  }>;
}

function asInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeIp(raw: string | undefined): string {
  if (!raw) return "unknown";
  return raw.trim().toLowerCase();
}

function safePath(path: string): string {
  return path.length > 300 ? `${path.slice(0, 300)}...` : path;
}

export function readCyberTigerConfigFromEnv(): CyberTigerConfig {
  return {
    enabled: asBool(process.env.CYBERTIGER_ENABLED, true),
    rateLimitWindowMs: asInt(process.env.CYBERTIGER_RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: asInt(process.env.CYBERTIGER_RATE_LIMIT_MAX, 120),
    authFailureWindowMs: asInt(process.env.CYBERTIGER_AUTH_FAILURE_WINDOW_MS, 300_000),
    authFailureThreshold: asInt(process.env.CYBERTIGER_AUTH_FAILURE_THRESHOLD, 8),
    autoBlockSeconds: asInt(process.env.CYBERTIGER_AUTO_BLOCK_SECONDS, 900),
    maxEvents: asInt(process.env.CYBERTIGER_MAX_EVENTS, 5000),
  };
}

const SIGNATURE_PATTERNS: Array<{ name: string; pattern: RegExp; severity: CyberTigerSeverity }> = [
  { name: "path-traversal", pattern: /(\.\.\/|%2e%2e%2f|%2e%2e\\)/i, severity: "high" },
  { name: "sql-injection", pattern: /(union\s+select|;\s*drop\s+table|sleep\(|benchmark\()/i, severity: "critical" },
  { name: "xss-marker", pattern: /(<script|%3cscript|javascript:)/i, severity: "high" },
  { name: "cmd-injection", pattern: /(;|\|\||&&)\s*(cat|bash|sh|curl|wget)\b/i, severity: "critical" },
];

export class CyberTigerDaemon {
  private readonly config: CyberTigerConfig;
  private readonly rateByIp = new Map<string, RateBucket>();
  private readonly authFailuresByIp = new Map<string, AuthFailureWindow>();
  private readonly blocklist = new Map<string, BlockRecord>();
  private readonly events: CyberTigerEvent[] = [];
  private counters = {
    totalInspected: 0,
    blocked: 0,
    signatureHits: 0,
    rateLimited: 0,
    authFailures: 0,
  };

  constructor(config?: Partial<CyberTigerConfig>) {
    this.config = {
      ...readCyberTigerConfigFromEnv(),
      ...(config ?? {}),
    };
  }

  extractClientIp(req: Request): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      const first = forwarded.split(",")[0];
      return normalizeIp(first);
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return normalizeIp(forwarded[0]);
    }
    return normalizeIp(req.ip ?? req.socket.remoteAddress ?? undefined);
  }

  inspectRequest(req: Request): CyberTigerInspectDecision {
    const requestId = randomUUID();
    const ip = this.extractClientIp(req);

    if (!this.config.enabled) {
      return { allowed: true, requestId, ip };
    }

    this.counters.totalInspected += 1;
    this.cleanupExpiredBlocks();

    const blocked = this.blocklist.get(ip);
    if (blocked && blocked.untilMs > Date.now()) {
      this.counters.blocked += 1;
      this.addEvent({
        type: "request.blocked_ip",
        severity: "high",
        ip,
        method: req.method,
        path: safePath(req.originalUrl ?? req.url),
        requestId,
        message: `Request denied from blocked IP (${blocked.reason})`,
      });
      return {
        allowed: false,
        requestId,
        ip,
        status: 429,
        message: "Request blocked by CyberTiger",
      };
    }

    const signature = this.detectSignature(req);
    if (signature) {
      this.counters.blocked += 1;
      this.counters.signatureHits += 1;
      this.addEvent({
        type: "request.signature",
        severity: signature.severity,
        ip,
        method: req.method,
        path: safePath(req.originalUrl ?? req.url),
        requestId,
        message: `Matched signature: ${signature.name}`,
      });
      this.blockIp(ip, `signature:${signature.name}`, undefined, {
        requestId,
        method: req.method,
        path: safePath(req.originalUrl ?? req.url),
      });
      return {
        allowed: false,
        requestId,
        ip,
        status: 400,
        message: "Suspicious request signature detected",
      };
    }

    if (!this.applyRateLimit(ip)) {
      this.counters.blocked += 1;
      this.counters.rateLimited += 1;
      this.addEvent({
        type: "request.rate_limit",
        severity: "medium",
        ip,
        method: req.method,
        path: safePath(req.originalUrl ?? req.url),
        requestId,
        message: "Rate limit exceeded",
      });
      return {
        allowed: false,
        requestId,
        ip,
        status: 429,
        message: "Rate limit exceeded",
      };
    }

    return { allowed: true, requestId, ip };
  }

  recordResponse(input: CyberTigerRecordResponseInput): void {
    if (!this.config.enabled) {
      return;
    }

    const path = safePath(input.path);
    if (input.status === 401 || input.status === 403) {
      this.counters.authFailures += 1;
      const breach = this.registerAuthFailure(input.ip);
      this.addEvent({
        type: "auth.failure",
        severity: "medium",
        ip: input.ip,
        method: input.method,
        path,
        requestId: input.requestId,
        status: input.status,
        actorRole: input.role,
        actorUserId: input.userId,
        message: "Authorization failure recorded",
      });
      if (breach) {
        this.addEvent({
          type: "auth.failure_threshold",
          severity: "high",
          ip: input.ip,
          method: input.method,
          path,
          requestId: input.requestId,
          status: input.status,
          message: "Auth failure threshold exceeded; IP auto-blocked",
          metadata: {
            threshold: this.config.authFailureThreshold,
            windowMs: this.config.authFailureWindowMs,
          },
        });
        this.blockIp(input.ip, "auth-failure-threshold", undefined, {
          requestId: input.requestId,
          method: input.method,
          path,
        });
      }
      return;
    }

    if (input.status >= 500) {
      this.addEvent({
        type: "http.error",
        severity: "low",
        ip: input.ip,
        method: input.method,
        path,
        requestId: input.requestId,
        status: input.status,
        actorRole: input.role,
        actorUserId: input.userId,
        message: "Server error response observed",
        metadata: input.latencyMs != null ? { latencyMs: input.latencyMs } : undefined,
      });
    }
  }

  blockIp(
    ip: string,
    reason: string,
    seconds?: number,
    metadata?: { requestId?: string; method?: string; path?: string; actorUserId?: string; actorRole?: AuthRole },
  ): void {
    const durationSec = seconds && seconds > 0 ? seconds : this.config.autoBlockSeconds;
    const untilMs = Date.now() + durationSec * 1000;
    this.blocklist.set(ip, { untilMs, reason });
    this.addEvent({
      type: "ip.blocked",
      severity: "high",
      ip,
      requestId: metadata?.requestId,
      method: metadata?.method,
      path: metadata?.path,
      actorUserId: metadata?.actorUserId,
      actorRole: metadata?.actorRole,
      message: `IP blocked for ${durationSec}s (${reason})`,
      metadata: {
        until: new Date(untilMs).toISOString(),
      },
    });
  }

  unblockIp(
    ip: string,
    metadata?: { actorUserId?: string; actorRole?: AuthRole },
  ): boolean {
    const existed = this.blocklist.delete(ip);
    if (existed) {
      this.addEvent({
        type: "ip.unblocked",
        severity: "info",
        ip,
        actorUserId: metadata?.actorUserId,
        actorRole: metadata?.actorRole,
        message: "IP removed from blocklist",
      });
    }
    return existed;
  }

  getEvents(limit = 200): CyberTigerEvent[] {
    const max = Math.max(1, Math.min(limit, this.config.maxEvents));
    return this.events.slice(Math.max(0, this.events.length - max)).reverse();
  }

  getStatus(): CyberTigerStatus {
    this.cleanupExpiredBlocks();
    return {
      enabled: this.config.enabled,
      config: this.config,
      counters: {
        totalInspected: this.counters.totalInspected,
        blocked: this.counters.blocked,
        signatureHits: this.counters.signatureHits,
        rateLimited: this.counters.rateLimited,
        authFailures: this.counters.authFailures,
        activeBlocks: this.blocklist.size,
        storedEvents: this.events.length,
      },
      activeBlocks: Array.from(this.blocklist.entries()).map(([ip, value]) => ({
        ip,
        until: new Date(value.untilMs).toISOString(),
        reason: value.reason,
      })),
    };
  }

  private addEvent(event: Omit<CyberTigerEvent, "id" | "timestamp">): void {
    this.events.push({
      id: randomUUID(),
      timestamp: nowIso(),
      ...event,
    });
    if (this.events.length > this.config.maxEvents) {
      this.events.splice(0, this.events.length - this.config.maxEvents);
    }
  }

  private cleanupExpiredBlocks(): void {
    const now = Date.now();
    for (const [ip, info] of this.blocklist.entries()) {
      if (info.untilMs <= now) {
        this.blocklist.delete(ip);
      }
    }
  }

  private applyRateLimit(ip: string): boolean {
    const now = Date.now();
    const existing = this.rateByIp.get(ip);
    if (!existing || now - existing.windowStartMs >= this.config.rateLimitWindowMs) {
      this.rateByIp.set(ip, {
        windowStartMs: now,
        count: 1,
      });
      return true;
    }
    existing.count += 1;
    return existing.count <= this.config.rateLimitMax;
  }

  private registerAuthFailure(ip: string): boolean {
    const now = Date.now();
    const existing = this.authFailuresByIp.get(ip);
    if (!existing || now - existing.windowStartMs >= this.config.authFailureWindowMs) {
      this.authFailuresByIp.set(ip, {
        windowStartMs: now,
        failures: 1,
      });
      return false;
    }
    existing.failures += 1;
    return existing.failures >= this.config.authFailureThreshold;
  }

  private detectSignature(
    req: Request,
  ): { name: string; severity: CyberTigerSeverity } | null {
    const rawCandidate = `${req.method} ${req.originalUrl ?? req.url}`.toLowerCase();
    let decodedCandidate = rawCandidate;
    try {
      decodedCandidate = decodeURIComponent(rawCandidate);
    } catch {
      decodedCandidate = rawCandidate;
    }
    for (const signature of SIGNATURE_PATTERNS) {
      if (signature.pattern.test(rawCandidate) || signature.pattern.test(decodedCandidate)) {
        return { name: signature.name, severity: signature.severity };
      }
    }
    return null;
  }
}
