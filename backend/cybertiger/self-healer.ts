/**
 * SelfHealerAgent — CyberTiger extension for internal system health.
 *
 * Monitors the ingestion loop, ML forecast freshness, and Bedrock growth.
 * When anomalies are detected it attempts automated remediation before
 * escalating to operator alerts via the CyberTiger event stream.
 *
 * 3-Layer Redundancy watchdog:
 *  L1 — Checks live API feed freshness
 *  L2 — Checks Bedrock local persistence is actively growing
 *  L3 — Checks ML forecast confidence is not drifting to zero
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export type HealerSeverity = "nominal" | "watch" | "alert" | "critical";

export interface HealEvent {
  timestamp: string;
  layer: "L1" | "L2" | "L3";
  diagnosis: string;
  action: string;
  severity: HealerSeverity;
  resolved: boolean;
}

interface SystemSnapshot {
  lastCanonicalMs: number | null;
  lastBedrockWriteMs: number | null;
  mlForecastConfidence: number | null;
  mlFlatlineCount: number;
}

const INGEST_STALL_MS = 90_000;      // 90s without a new canonical point = stall
const ML_CONFIDENCE_FLOOR = 0.35;   // below this for 3 consecutive reads = drift
const BEDROCK_STALL_MS = 300_000;   // 5 min with no new Bedrock write = persistence stall
const CHECK_INTERVAL_MS = 60_000;   // check health every 60 seconds

export class SelfHealerAgent extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private snapshot: SystemSnapshot = {
    lastCanonicalMs: null,
    lastBedrockWriteMs: null,
    mlForecastConfidence: null,
    mlFlatlineCount: 0,
  };
  private healLog: HealEvent[] = [];
  private onRequestTrainingFn: (() => Promise<void>) | null = null;
  private onResetIngestionFn: (() => void) | null = null;

  constructor(
    private options: {
      proxyPort?: number;
      trainingEndpoint?: string;
    } = {}
  ) {
    super();
  }

  /**
   * Register callbacks from the main server so the healer can trigger
   * remediation actions without circular imports.
   */
  register(callbacks: {
    onRequestTraining: () => Promise<void>;
    onResetIngestion: () => void;
  }): void {
    this.onRequestTrainingFn = callbacks.onRequestTraining;
    this.onResetIngestionFn = callbacks.onResetIngestion;
  }

  start(): void {
    if (this.timer) return;
    console.log("[SelfHealer] Started — monitoring L1/L2/L3 redundancy layers");
    this.timer = setInterval(() => this.runHealthCycle(), CHECK_INTERVAL_MS);
    // Run immediately
    this.runHealthCycle().catch(console.error);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Called by ingest-loop on each successful canonical tick */
  notifyCanonicalTick(): void {
    this.snapshot.lastCanonicalMs = Date.now();
  }

  /** Called by Bedrock after each write */
  notifyBedrockWrite(): void {
    this.snapshot.lastBedrockWriteMs = Date.now();
  }

  /** Called by ingest-loop after each ML forecast poll */
  notifyForecastConfidence(confidence: number): void {
    const prev = this.snapshot.mlForecastConfidence;
    this.snapshot.mlForecastConfidence = confidence;

    if (confidence < ML_CONFIDENCE_FLOOR) {
      this.snapshot.mlFlatlineCount += 1;
    } else {
      this.snapshot.mlFlatlineCount = 0;
    }

    if (prev !== null && Math.abs(confidence - prev) > 0.3) {
      console.warn(`[SelfHealer] Large ML confidence swing: ${prev.toFixed(2)} → ${confidence.toFixed(2)}`);
    }
  }

  getHealLog(limit = 50): HealEvent[] {
    return this.healLog.slice(-limit).reverse();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async runHealthCycle(): Promise<void> {
    await this.checkL1IngestionFreshness();
    await this.checkL2BedrockPersistence();
    this.checkL3MLDrift();
  }

  /** L1: Ensure the ingestion loop is producing fresh canonical points */
  private async checkL1IngestionFreshness(): Promise<void> {
    const { lastCanonicalMs } = this.snapshot;
    if (lastCanonicalMs === null) return; // not yet started

    const ageMs = Date.now() - lastCanonicalMs;
    if (ageMs < INGEST_STALL_MS) return;

    const staleSec = Math.round(ageMs / 1000);
    this.log({
      layer: "L1",
      diagnosis: `Ingestion stall detected: no canonical point for ${staleSec}s`,
      action: "Resetting ingestion worker timer and forcing synthetic tick",
      severity: ageMs > INGEST_STALL_MS * 3 ? "critical" : "alert",
      resolved: true,
    });

    // Remediation: reset the ingestion worker
    if (this.onResetIngestionFn) {
      this.onResetIngestionFn();
    }
  }

  /** L2: Ensure Bedrock local persistence is actively receiving writes */
  private async checkL2BedrockPersistence(): Promise<void> {
    const { lastBedrockWriteMs } = this.snapshot;
    if (lastBedrockWriteMs === null) return;

    const ageMs = Date.now() - lastBedrockWriteMs;
    if (ageMs < BEDROCK_STALL_MS) return;

    const staleSec = Math.round(ageMs / 1000);
    this.log({
      layer: "L2",
      diagnosis: `Bedrock write stall: no persistence event for ${staleSec}s`,
      action: "Emitting bedrock-stall event for operator notification",
      severity: "watch",
      resolved: false,
    });

    this.emit("bedrock-stall", { staleSec });
  }

  /** L3: Detect ML forecast confidence collapse */
  private checkL3MLDrift(): void {
    if (this.snapshot.mlFlatlineCount < 3) return;

    this.log({
      layer: "L3",
      diagnosis: `ML confidence below floor (${ML_CONFIDENCE_FLOOR}) for ${this.snapshot.mlFlatlineCount} consecutive reads`,
      action: "Triggering model retrain via POST /api/ai/nowcast/train",
      severity: this.snapshot.mlFlatlineCount >= 6 ? "critical" : "alert",
      resolved: true,
    });

    // Remediation: trigger internal training
    if (this.onRequestTrainingFn) {
      this.onRequestTrainingFn().catch((err) => {
        console.error("[SelfHealer] Training request failed:", err);
      });
    }

    this.snapshot.mlFlatlineCount = 0;
  }

  /** Trigger the closed-loop training pipeline as a detached child process */
  async triggerClosedLoop(): Promise<{ started: boolean; message: string }> {
    const script = process.env.CLOSED_LOOP_SCRIPT ?? "scripts/closed-loop.sh";
    return new Promise((resolve) => {
      const child = spawn("bash", [script], {
        stdio: "ignore",
        detached: true,
        env: { ...process.env },
      });
      child.on("error", (err) => {
        resolve({ started: false, message: `Failed: ${err.message}` });
      });
      child.unref();
      resolve({ started: true, message: `Closed-loop started (bash ${script})` });
    });
  }

  private log(event: Omit<HealEvent, "timestamp">): void {
    const entry: HealEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.healLog.push(entry);
    if (this.healLog.length > 500) this.healLog.shift();

    const icon = event.severity === "nominal" ? "✓" : event.severity === "watch" ? "⚠" : "✖";
    console.log(`[SelfHealer] ${icon} [${entry.layer}] ${entry.diagnosis} → ${entry.action}`);
    this.emit("heal-event", entry);
  }
}
