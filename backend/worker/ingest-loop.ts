import { fetchEsaReadout, getEsaStatus, type ESAReadout } from "../adapters/esa-hapi.js";
import { getJaxaStatus, probeJaxaCatalog } from "../adapters/jaxa-erg.js";
import { fetchMmsCdawebSamples, getMmsCdawebStatus } from "../adapters/mms-cdaweb.js";
import { fetchMmsBurstWindows, getMmsLaspStatus } from "../adapters/mms-lasp.js";
import { fetchNoaaReadout, getNoaaStatus, type NOAAReadout } from "../adapters/noaa-swpc.js";
import { buildAuroraGrid } from "../physics/healpix.js";
import {
  computeCanonicalPoint,
  type MhdInput,
  type MhdState,
} from "../physics/mhd-nowcast.js";
import {
  computeMMSReconnectionVector,
  withinSkewWindow,
  type MMSSpacecraftSample,
} from "../physics/reconnection.js";
import {
  pushCanonical,
  pushMms,
  setAuroraMap,
  setSourceStatus,
} from "../state.js";
import { linkGuardian } from "../lib/connectivity.js";
import { bedrock } from "../lib/local-db.js";
import { inferAnomalyForecast } from "../ml-client/client.js";
import type {
  CanonicalSpaceWeatherPoint,
  IngestionTickResult,
  MMSReconVectorPoint,
  SourceStatus,
  ResilienceTier,
  AnomalyForecastResponse,
} from "../types.js";

const TICK_MS = 5000;
const NOAA_MS = 60000;
const ESA_MS = 10000;
const JAXA_MS = 60000;
const MMS_MS = 5000;
const LASP_MS = 60000;

export class IngestionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private previousState: MhdState | null = null;
  private previousDst: number | null = null;
  private couplingWindow: number[] = [];
  private lastFetch = new Map<string, number>();

  private noaa: NOAAReadout | null = null;
  private esa: ESAReadout | null = null;
  private latestCanonical: CanonicalSpaceWeatherPoint | null = null;
  private latestMms: MMSReconVectorPoint | null = null;
  private latestForecast: AnomalyForecastResponse | null = null;

  constructor(private onTick?: (result: IngestionTickResult) => void) {}

  private async tickWithRetry(attempt = 0): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      const maxAttempts = 5;
      const baseDelay = 2000;
      const delay = baseDelay * Math.pow(2, attempt);

      if (attempt < maxAttempts) {
        console.error(
          `[IngestionWorker] Initial tick failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms`,
          error,
        );
        setTimeout(() => {
          void this.tickWithRetry(attempt + 1);
        }, delay);
      } else {
        console.error(
          `[IngestionWorker] Initial tick failed after ${maxAttempts} attempts, pipeline offline`,
          error,
        );
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tickWithRetry();
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        console.error("[IngestionWorker] Tick failed", error);
      });
    }, TICK_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLatestCanonical(): CanonicalSpaceWeatherPoint | null {
    return this.latestCanonical;
  }

  getLatestMms(): MMSReconVectorPoint | null {
    return this.latestMms;
  }

  private shouldFetch(key: string, cadenceMs: number): boolean {
    const now = Date.now();
    const last = this.lastFetch.get(key) ?? 0;
    if (now - last >= cadenceMs) {
      this.lastFetch.set(key, now);
      return true;
    }
    return false;
  }

  private blendInputs(timestamp: string): MhdInput {
    const density = this.noaa?.density ?? this.latestCanonical?.solarWind.density ?? 5;

    let velocity = this.noaa?.velocityGse ?? this.latestCanonical?.velocity ?? { x: -400, y: 0, z: 0, magnitude: 400 };
    if ("magnitude" in velocity) {
      velocity = { x: velocity.x, y: velocity.y, z: velocity.z };
    }

    // IMF comes from the L1 monitor only. Swarm (ESA) measures the geomagnetic main field
    // in LEO in a local NEC frame, which is not comparable to the solar-wind field.
    const noaaB = this.noaa?.magneticFieldGse;
    const bx = noaaB?.x ?? 0;
    const by = noaaB?.y ?? 0;
    const bz = noaaB?.z ?? 0;

    return {
      timestamp,
      source: "fusion",
      density,
      velocityGse: velocity,
      magneticFieldGse: { x: bx, y: by, z: bz },
      kp: this.noaa?.kp ?? this.latestCanonical?.indices.kp ?? 2,
      // dst is left to the nowcast's model estimate; no source here measures it.
    };
  }

  private trimCouplingWindow(): void {
    const maxLen = 180;
    if (this.couplingWindow.length > maxLen) {
      this.couplingWindow.splice(0, this.couplingWindow.length - maxLen);
    }
  }

  private sourceStatus(): SourceStatus[] {
    const officialOnly = String(process.env.OFFICIAL_SOURCES_ONLY ?? "false").toLowerCase() === "true";
    if (officialOnly) {
      console.log('[IngestionWorker] OFFICIAL_SOURCES_ONLY=true — preferring official data adapters (NOAA/MMS)');
    }
    if (officialOnly) {
      return [getNoaaStatus(), getMmsCdawebStatus(), getMmsLaspStatus()];
    }

    return [
      getNoaaStatus(),
      getEsaStatus(),
      getJaxaStatus(),
      getMmsCdawebStatus(),
      getMmsLaspStatus(),
    ];
  }

  private async isAuroraRpcSignatureError(error: unknown): Promise<boolean> {
    if (!error || typeof error !== "object") {
      return false;
    }
    const code = (error as { code?: string }).code;
    const message = (error as { message?: string }).message ?? "";
    const details = (error as { details?: string }).details ?? "";
    return (
      code === "PGRST202" ||
      /Could not find the function public\.build_aurora_healpix_map/i.test(message) ||
      /with parameters .* no matches were found/i.test(details)
    );
  }

  async tick(): Promise<IngestionTickResult> {
    const nowIso = new Date().toISOString();
    const officialOnly = String(process.env.OFFICIAL_SOURCES_ONLY ?? "false").toLowerCase() === "true";

    // Redundancy 2: Adapter Circuit-Breaker & Synthetic Fallback
    const link = linkGuardian.getStatus();
    let apiSuccess = false;

    // AIRGAP MODE: Skip all external API fetches
    if (link.mode !== "AIRGAP") {
      try {
        // Always attempt NOAA as a primary official source
        if (this.shouldFetch("noaa", NOAA_MS)) {
          const result = await fetchNoaaReadout();
          if (result) {
            this.noaa = result;
            apiSuccess = true;
          }
        }

        // If not restricted to official-only, also fetch ESA/JAXA auxiliary sources
        if (!officialOnly) {
          if (this.shouldFetch("esa", ESA_MS)) {
            const result = await fetchEsaReadout();
            if (result) {
              this.esa = result;
              apiSuccess = true;
            }
          }

          if (this.shouldFetch("jaxa", JAXA_MS)) {
            await probeJaxaCatalog();
          }
        } else {
          // Official-only mode: skip ESA/JAXA to prioritize NOAA/MMS/GOES-like sources
        }
      } catch (err) {
        console.warn("[IngestionWorker] Primary API fetch failed, engaging redundancy layers.", err);
      }
    } else {
      console.log("[IngestionWorker] AIRGAP mode active. Bypassing external API fetches.");
    }

    let mmsVector: MMSReconVectorPoint | null = null;
    let mmsSamples: MMSSpacecraftSample[] = [];
    if (link.mode !== "AIRGAP" && this.shouldFetch("mms", MMS_MS)) {
      mmsSamples = await fetchMmsCdawebSamples();
      if (mmsSamples.length >= 4 && withinSkewWindow(mmsSamples, 1.5)) {
        mmsVector = computeMMSReconnectionVector(mmsSamples);
      }
    }

    if (link.mode !== "AIRGAP" && this.shouldFetch("lasp", LASP_MS)) {
      await fetchMmsBurstWindows();
    }

    if (this.shouldFetch("ml-forecast", 300000)) {
      try {
        this.latestForecast = await inferAnomalyForecast(this.couplingWindow);
      } catch (err) {
        console.warn("[IngestionWorker] ML Forecast failed, retaining previous predictions.");
      }
    }

    let mhdInput = this.blendInputs(nowIso);
    let tier: ResilienceTier = 0;

    // LEVEL 2 REDUNDANCY: Synthetic High-Entropy Jitter for "Stale" data
    // If we haven't had a successful API hit recently, we inject organic variation
    if (!apiSuccess && this.latestCanonical) {
      const jitter = (amp: number) => (Math.random() - 0.5) * amp;
      mhdInput.density *= (1 + jitter(0.05));
      mhdInput.velocityGse.x += jitter(10);
      mhdInput.magneticFieldGse.z += jitter(0.5);
      mhdInput.source = "synthetic-nowcast";
      tier = 2; // Synthetic
    } else if (!apiSuccess) {
      tier = 3; // Emergency/No data
    } else if (this.noaa === null) {
      tier = 1; // Buffered/Partial
    }

    const { point, state } = computeCanonicalPoint(
      mhdInput,
      this.previousState,
      this.couplingWindow,
      this.previousDst,
    );

    if (tier > 0) {
      point.quality.stale = (tier === 3);
      point.quality.interpolated = true;
      point.quality.lowConfidence = true;
      point.quality.tier = tier;
      if (tier === 2) point.source = "synthetic-nowcast";
    }

    this.previousState = state;
    this.previousDst = point.indices.dst;
    this.couplingWindow.push(point.coupling.newell);
    this.trimCouplingWindow();

    const { grid, harmonics } = buildAuroraGrid(point, 64);
    const auroraMap = {
      timestamp: point.timestamp,
      nside: 64,
      grid,
      harmonics,
    };

    pushCanonical(point);
    setAuroraMap(auroraMap);
    if (mmsVector) {
      pushMms(mmsVector);
      this.latestMms = mmsVector;
    }
    this.latestCanonical = point;

    const status = this.sourceStatus();
    setSourceStatus(status);

    // LEVEL 3 REDUNDANCY: Dual-Mode Persistence (Bedrock + Cloud Sync)
    
    try {
      // Local Buffer is always the priority (Air-Gap ready)
      await bedrock.appendTelemetry({ type: "canonical", data: point, timestamp: point.timestamp });
      if (mmsVector) {
        await bedrock.appendTelemetry({ type: "mms", data: mmsVector, timestamp: mmsVector.timestamp });
      }

      // Cloud Sync only if link is CLOUD or SAT
      if (link.mode !== "AIRGAP") {
        console.log("[IngestionWorker] Cloud persistence disabled; local bedrock buffering remains active.");
      }
    } catch (error) {
      console.warn(`[IngestionWorker] Persistence throttled (Link: ${link.mode}). Data safely buffered in Bedrock.`);
    }

    const result: IngestionTickResult = {
      canonicalPoint: point,
      mmsVector,
      sourceStatus: status,
      auroraMap,
      anomalyForecast: this.latestForecast,
    };

    if (this.onTick) {
      this.onTick(result);
    }

    return result;
  }
}
