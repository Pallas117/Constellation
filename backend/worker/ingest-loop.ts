import { fetchEsaReadout, getEsaStatus, type ESAReadout } from "../adapters/esa-hapi.js";
import {
  freshReading,
  freshXray,
  fetchGoesParticles,
  getGoesStatus,
  PARTICLE_MAX_AGE_MS,
  type GoesParticleReadout,
} from "../adapters/goes-particles.js";
import { fetchSwpcProducts, type SwpcProducts } from "../adapters/swpc-products.js";
import { checkFieldMagnitude, checkPlasmaTracking, compareScales, expireCheck, fieldSampleProblem } from "../lib/sense-checks.js";
import { geomagneticStorm, radiationStorm, radioBlackout } from "../physics/noaa-scales.js";
import { getJaxaStatus, probeJaxaCatalog } from "../adapters/jaxa-erg.js";
import { fetchKyotoDst, freshDst, getKyotoDstStatus, type DstReading } from "../adapters/kyoto-dst.js";
import { fetchMmsCdawebSamples, getMmsCdawebStatus } from "../adapters/mms-cdaweb.js";
import { fetchMmsBurstWindows, getMmsLaspStatus } from "../adapters/mms-lasp.js";
import { fetchNoaaReadout, getNoaaStatus, type KpReading, type NOAAReadout } from "../adapters/noaa-swpc.js";
import { arrivingNow, type L1Sample } from "../adapters/rtsw-series.js";
import { gseToGsm, magnitude } from "../physics/coordinates.js";
import { buildAuroraGrid } from "../physics/healpix.js";
import { computeCanonicalPoint, type MhdInput } from "../physics/mhd-nowcast.js";
import {
  computeMMSReconnectionVector,
  withinSkewWindow,
  type MMSSpacecraftSample,
} from "../physics/reconnection.js";
import {
  getCanonicalFeed,
  pushCanonical,
  pushMms,
  setAuroraMap,
  setSourceStatus,
} from "../state.js";
import { linkGuardian } from "../lib/connectivity.js";
import { PipelineTimer, STAGE_BUDGET_MS } from "../lib/pipeline-timing.js";
import { ForecastSkillTracker } from "../lib/tpm.js";
import { bedrock } from "../lib/local-db.js";
import { inferAnomalyForecast } from "../ml-client/client.js";
import type {
  CanonicalSpaceWeatherPoint,
  DerivedField,
  IngestionTickResult,
  MMSReconVectorPoint,
  SenseCheck,
  SourceStatus,
  ResilienceTier,
  AnomalyForecastResponse,
  PipelineLatencySnapshot,
} from "../types.js";

export const TICK_MS = 5000;
const NOAA_MS = 60000;
const ESA_MS = 10000;
const JAXA_MS = 60000;
const MMS_MS = 10 * 60 * 1000; // archival L2 product; polling faster gains nothing
const LASP_MS = 60000;
const GOES_MS = 60000; // GOES publishes every 5 min; a 60 s poll keeps worst-case lag under 6 min
const KYOTO_DST_MS = 10 * 60 * 1000; // hourly product
const SWPC_PRODUCTS_MS = 2 * 60 * 1000; // NOAA scales and alerts: a cross-check, updated every few minutes

// Freshness is judged by the age of the measurement itself, not by whether a fetch ran
// this tick. Beyond NOAA_MAX_AGE_MS a readout is discarded rather than carried forward.
export const NOAA_FRESH_MS = 10 * 60 * 1000;
export const NOAA_MAX_AGE_MS = 15 * 60 * 1000; // GAU-15: carried values expire at 15 min

/** 0 live, 1 buffered (measured but ageing), 3 stale (no measurement within the cap). */
export function freshnessTier(dataTimestamp: string | null, nowMs: number): ResilienceTier {
  if (!dataTimestamp) return 3;
  const t = Date.parse(dataTimestamp);
  if (!Number.isFinite(t)) return 3;
  const age = nowMs - t;
  if (age <= NOAA_FRESH_MS) return 0;
  if (age <= NOAA_MAX_AGE_MS) return 1;
  return 3;
}

/** History the Kp forecaster needs (ml/kp_model.py WINDOW_HOURS), sent at one point per minute. */
export const FORECAST_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * The last FORECAST_WINDOW_MS of measured (non-stale) canonical points, thinned to the first point
 * of each minute so a 5 s feed becomes about 360 points. GAU-115.
 */
export function forecastWindow(
  feed: CanonicalSpaceWeatherPoint[],
  nowMs: number,
): CanonicalSpaceWeatherPoint[] {
  const out: CanonicalSpaceWeatherPoint[] = [];
  let lastMinute = -Infinity;
  for (const point of feed) {
    if (point.quality?.stale) continue;
    const t = Date.parse(point.timestamp);
    if (!Number.isFinite(t) || nowMs - t > FORECAST_WINDOW_MS || t > nowMs) continue;
    const minute = Math.floor(t / 60_000);
    if (minute === lastMinute) continue;
    lastMinute = minute;
    out.push(point);
  }
  return out;
}

/** The sources a worker can fetch. */
export type IngestSource = "noaa" | "kyoto-dst" | "goes" | "swpc-products" | "esa" | "jaxa" | "mms" | "lasp";

/**
 * How a worker runs. The defaults are the live service. A historical replay (GAU-138) runs the
 * same tick with a stepped clock, its own sources, and nothing published or persisted.
 */
export interface IngestionOptions {
  /** Clock, ms since the epoch. Default Date.now. */
  now?: () => number;
  /** Sources to fetch; default all. */
  sources?: readonly IngestSource[];
  /** Run the Kp forecaster every 5 min (default true). */
  forecast?: boolean;
  /** Build the aurora grid every tick (default true). */
  auroraGrid?: boolean;
  /** Push each point to the shared feed and persist it to bedrock (default true). A replay must not. */
  publish?: boolean;
  /** Skip fetches while the link guardian reports AIRGAP (default true). A replay reads an archive. */
  respectLink?: boolean;
}

export class IngestionWorker {
  private timer: NodeJS.Timeout | null = null;
  /** The pending start-up retry, so stop() can cancel it (GAU-208). */
  private retryTimer: NodeJS.Timeout | null = null;
  private running = false;
  private previousDst: number | null = null;
  private couplingWindow: number[] = [];
  private lastFetch = new Map<string, number>();

  private noaa: NOAAReadout | null = null;
  /**
   * L1 history, kept when the latest readout expires: solar wind already measured
   * keeps arriving at Earth for one travel time (~45 min) after an L1 outage.
   */
  private l1Series: L1Sample[] = [];
  /**
   * NOAA Kp, kept apart from the L1 readout: Kp comes from ground magnetometers, so an L1 data gap
   * must not make the geomagnetic level unknown. Its own 6 h age limit still applies (noaa-scales).
   * Found by the Jan 2026 replay: 30 min of L1 fills turned G0 into "G?" (GAU-138).
   */
  private kpReading: KpReading | null = null;
  private esa: ESAReadout | null = null;
  private goes: GoesParticleReadout | null = null;
  private swpcProducts: SwpcProducts | null = null;
  private kyotoDst: DstReading | null = null;
  private latestCanonical: CanonicalSpaceWeatherPoint | null = null;
  private latestMms: MMSReconVectorPoint | null = null;
  private latestForecast: AnomalyForecastResponse | null = null;
  /** Timestamp of the newest NOAA measurement seen, kept after expiry so its age stays visible. */
  private lastMeasurementAt: string | null = null;
  private ticking = false;
  private loggedCloudDisabled = false;
  /** Live skill of served forecasts vs persistence (TPM forecast_skill, FMEA FM-09). GAU-122. */
  readonly forecastSkill = new ForecastSkillTracker();
  readonly timing = new PipelineTimer();

  private readonly now: () => number;

  constructor(
    private onTick?: (result: IngestionTickResult) => void,
    private readonly options: IngestionOptions = {},
  ) {
    // Read Date.now on every call, so anything that substitutes it (tests, fake timers) is honoured.
    this.now = options.now ?? (() => Date.now());
  }

  private wants(source: IngestSource): boolean {
    return !this.options.sources || this.options.sources.includes(source);
  }

  private async tickWithRetry(attempt = 0): Promise<void> {
    // A retry chain from before a restart must not tick alongside the new one (GAU-208).
    if (!this.running) return;
    try {
      await this.tick();
    } catch (error) {
      const maxAttempts = 5;
      const baseDelay = 2000;
      const delay = baseDelay * Math.pow(2, attempt);

      if (attempt < maxAttempts && this.running) {
        console.error(
          `[IngestionWorker] Initial tick failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms`,
          error,
        );
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.tickWithRetry(attempt + 1);
        }, delay);
      } else if (this.running) {
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
      // Never stack ticks: an overlapping tick would publish out of order and hide a slow stage.
      if (this.ticking) {
        this.timing.tickSkipped();
        return;
      }
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
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  getLatestCanonical(): CanonicalSpaceWeatherPoint | null {
    return this.latestCanonical;
  }

  /** The forecast computed by the loop (every 5 min), or null before the first one. */
  getLatestForecast(): AnomalyForecastResponse | null {
    return this.latestForecast;
  }

  getLatestMms(): MMSReconVectorPoint | null {
    return this.latestMms;
  }

  getPipelineLatency(): PipelineLatencySnapshot {
    return this.timing.snapshot(TICK_MS, this.lastMeasurementAt, NOAA_FRESH_MS, NOAA_MAX_AGE_MS);
  }

  /** Fetch one source within its latency budget; a failure or timeout keeps the previous value. */
  private async timedFetch<T>(stage: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await this.timing.time(stage, fn, STAGE_BUDGET_MS[stage]);
    } catch (error) {
      console.warn(`[IngestionWorker] ${stage} fetch failed; keeping previous value.`, error);
      return null;
    }
  }

  private shouldFetch(key: string, cadenceMs: number): boolean {
    const now = this.now();
    const last = this.lastFetch.get(key) ?? 0;
    if (now - last >= cadenceMs) {
      this.lastFetch.set(key, now);
      return true;
    }
    return false;
  }

  private blendInputs(timestamp: string): MhdInput {
    // IMF comes from the L1 monitor only. Swarm (ESA) measures the geomagnetic main field
    // in LEO in a local NEC frame, which is not comparable to the solar-wind field.
    const noaa = this.noaa;
    if (noaa) {
      return {
        timestamp,
        observedAt: noaa.timestamp,
        source: "fusion",
        density: noaa.density,
        velocityGse: noaa.velocityGse,
        magneticFieldGse: noaa.magneticFieldGse,
        velocityGsm: noaa.velocityGsm ?? null,
        magneticFieldGsm: noaa.magneticFieldGsm ?? null,
        kp: noaa.kp,
        // Measured Kyoto Dst while it is under 2 h old; otherwise the nowcast's labelled model
        // estimate (O'Brien & McPherron) takes over. GAU-116.
        dst: freshDst(this.kyotoDst, Date.parse(timestamp)),
      };
    }
    // No current readout: carry the last point's measured values (already GSM), flagged by
    // the caller, rather than inventing a zero field. With no point at all, the values are
    // placeholders on a point flagged stale.
    const prev = this.latestCanonical;
    const v = prev ? { x: prev.velocity.x, y: prev.velocity.y, z: prev.velocity.z } : { x: -400, y: 0, z: 0 };
    const b = prev ? { x: prev.magneticField.x, y: prev.magneticField.y, z: prev.magneticField.z } : { x: 0, y: 0, z: 0 };
    return {
      timestamp,
      observedAt: prev?.observedAt ?? undefined,
      source: "fusion",
      density: prev?.solarWind.density ?? 5,
      velocityGse: v,
      magneticFieldGse: b,
      velocityGsm: v,
      magneticFieldGsm: b,
      kp: this.kpReading?.value ?? prev?.indices.kp ?? 2,
      dst: freshDst(this.kyotoDst, Date.parse(timestamp)),
    };
  }

  /**
   * Values on the point that were not measured as published, with how they were obtained (GAU-63).
   * A carried-forward point (no current readout) is described by its quality flags instead.
   */
  private derivedFields(): DerivedField[] {
    const noaa = this.noaa;
    if (!noaa) return [];
    const out: DerivedField[] = [];
    if (noaa.velocityAssumed) {
      out.push({ field: "velocity", method: "bulk flow assumed anti-sunward along X: no velocity vector was published", derivedFrom: ["proton_speed"] });
    }
    if (!noaa.magneticFieldGsm) {
      out.push({ field: "magneticField", method: "rotated GSE to GSM locally (Hapgood 1992)", derivedFrom: ["bx_gse", "by_gse", "bz_gse"] });
    }
    return out;
  }

  /**
   * Field consistency and plasma tracking over the L1 history, the GOES checks from the last
   * fetch (unknown once that fetch is older than the particle limit), and NOAA's scales against
   * this point's. An inconsistent newest field sample, or a speed that stopped following the
   * field (GAU-153), lowers the point's confidence; the rest only report.
   */
  private senseChecks(point: CanonicalSpaceWeatherPoint, nowMs: number): SenseCheck[] {
    const series = this.noaa ? this.l1Series : [];
    const endMs = this.noaa ? Date.parse(this.noaa.timestamp) : nowMs;
    const field = checkFieldMagnitude(series, this.noaa?.spacecraft, endMs);
    const newest = series.at(-1);
    if (newest && fieldSampleProblem(newest)) point.quality.lowConfidence = true;
    const plasma = checkPlasmaTracking(
      series.map((s) => ({ t: s.t, speed: s.speed, bt: s.bt ?? magnitude(s.magneticFieldGse) })),
      this.noaa?.spacecraft,
      endMs,
    );
    if (plasma.status === "flag") point.quality.lowConfidence = true;

    const goes: SenseCheck[] = (["goes-proton-spectrum", "goes-proton-channels", "goes-xray"] as const).map((id) => {
      const check = this.goes?.checks?.find((c) => c.id === id);
      return check
        ? expireCheck(check, nowMs, PARTICLE_MAX_AGE_MS, "GOES data")
        : { id, status: "unknown", reason: "GOES data not fetched", observedAt: null };
    });

    const scales = compareScales(
      this.swpcProducts?.scales ?? null,
      { R: point.alerts.radioBlackout, S: point.alerts.radiation, G: point.alerts.geomagnetic },
      nowMs,
    );
    return [field, plasma, ...goes, scales];
  }

  /** Hand the point to the shared feed and persist it locally. Never called by a replay. */
  private async publish(
    point: CanonicalSpaceWeatherPoint,
    auroraMap: IngestionTickResult["auroraMap"],
    mmsVector: MMSReconVectorPoint | null,
    status: SourceStatus[],
    linkMode: string,
  ): Promise<void> {
    pushCanonical(point);
    if (auroraMap) setAuroraMap(auroraMap);
    if (mmsVector) pushMms(mmsVector);
    setSourceStatus(status);

    // LEVEL 3 REDUNDANCY: Dual-Mode Persistence (Bedrock + Cloud Sync)
    try {
      // Local Buffer is always the priority (Air-Gap ready)
      await this.timing.time("persist", async () => {
        await bedrock.appendTelemetryStrict({ type: "canonical", data: point, timestamp: point.timestamp });
        if (mmsVector) {
          await bedrock.appendTelemetryStrict({ type: "mms", data: mmsVector, timestamp: mmsVector.timestamp });
        }
      });

      // Cloud Sync only if link is CLOUD or SAT
      if (linkMode !== "AIRGAP" && !this.loggedCloudDisabled) {
        this.loggedCloudDisabled = true; // once, not every 5 s tick
        console.log("[IngestionWorker] Cloud persistence disabled; local bedrock buffering remains active.");
      }
    } catch (error) {
      // The local write itself failed (disk full, permissions): the point is served from memory but
      // NOT persisted. The persist stage counts the error in /api/system/pipeline. GAU-121.
      console.error(`[IngestionWorker] Bedrock write failed; point not persisted (${bedrock.failedWrites} failed writes).`, error);
    }
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
      return [getNoaaStatus(), getGoesStatus(), getKyotoDstStatus(), getMmsCdawebStatus(), getMmsLaspStatus()];
    }

    return [
      getNoaaStatus(),
      getGoesStatus(),
      getKyotoDstStatus(),
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
    this.ticking = true;
    this.timing.tickStarted();
    try {
      const result = await this.runTick();
      this.timing.tickFinished();
      result.pipeline = this.getPipelineLatency();
      if (this.onTick) {
        this.onTick(result);
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<IngestionTickResult> {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const officialOnly = String(process.env.OFFICIAL_SOURCES_ONLY ?? "false").toLowerCase() === "true";

    const link = linkGuardian.getStatus();

    let mmsVector: MMSReconVectorPoint | null = null;

    // AIRGAP MODE: Skip all external API fetches.
    // Sources are fetched in parallel, each within its own budget, so the slowest source
    // bounds the tick instead of the sum of all of them.
    if (this.options.respectLink === false || link.mode !== "AIRGAP") {
      const fetches: Promise<unknown>[] = [];
      // Always attempt NOAA as a primary official source
      if (this.wants("noaa") && this.shouldFetch("noaa", NOAA_MS)) {
        fetches.push(
          this.timedFetch("noaa", () => fetchNoaaReadout(nowMs)).then((result) => {
            if (!result) return;
            this.noaa = result;
            if (result.series?.length) this.l1Series = result.series;
          }),
        );
      }
      if (this.wants("kyoto-dst") && this.shouldFetch("kyoto-dst", KYOTO_DST_MS)) {
        fetches.push(
          this.timedFetch("kyoto-dst", () => fetchKyotoDst(nowMs)).then((result) => {
            if (result) this.kyotoDst = result;
          }),
        );
      }
      if (this.wants("goes") && this.shouldFetch("goes", GOES_MS)) {
        fetches.push(
          this.timedFetch("goes", () => fetchGoesParticles(nowMs)).then((result) => {
            if (result) this.goes = result;
          }),
        );
      }
      if (this.wants("swpc-products") && this.shouldFetch("swpc-products", SWPC_PRODUCTS_MS)) {
        fetches.push(
          this.timedFetch("swpc-products", () => fetchSwpcProducts(nowMs)).then((result) => {
            if (result) this.swpcProducts = result;
          }),
        );
      }
      // If not restricted to official-only, also fetch ESA/JAXA auxiliary sources
      if (!officialOnly) {
        if (this.wants("esa") && this.shouldFetch("esa", ESA_MS)) {
          fetches.push(
            this.timedFetch("esa", () => fetchEsaReadout(nowMs)).then((result) => {
              if (result) this.esa = result;
            }),
          );
        }
        if (this.wants("jaxa") && this.shouldFetch("jaxa", JAXA_MS)) {
          fetches.push(this.timedFetch("jaxa", probeJaxaCatalog));
        }
      }
      if (this.wants("mms") && this.shouldFetch("mms", MMS_MS)) {
        fetches.push(
          this.timedFetch("mms", () => fetchMmsCdawebSamples(nowMs)).then((samples) => {
            const mmsSamples: MMSSpacecraftSample[] = samples ?? [];
            if (mmsSamples.length >= 4 && withinSkewWindow(mmsSamples, 1.5)) {
              mmsVector = computeMMSReconnectionVector(mmsSamples);
            }
          }),
        );
      }
      if (this.wants("lasp") && this.shouldFetch("lasp", LASP_MS)) {
        fetches.push(this.timedFetch("lasp", fetchMmsBurstWindows));
      }
      await Promise.all(fetches);
    } else {
      console.log("[IngestionWorker] AIRGAP mode active. Bypassing external API fetches.");
    }
    if (this.noaa?.timestamp) this.lastMeasurementAt = this.noaa.timestamp;

    if (this.options.forecast !== false && this.shouldFetch("ml-forecast", 300000)) {
      try {
        this.latestForecast = await this.timing.time(
          "ml-forecast",
          () => inferAnomalyForecast(forecastWindow(getCanonicalFeed(), Date.parse(nowIso))),
          STAGE_BUDGET_MS["ml-forecast"],
        );
        // Score every served forecast later against observed Kp; persistence = Kp measured now.
        const f = this.latestForecast;
        const kpNow = this.noaa?.kp;
        if (f?.available && typeof kpNow === "number" && freshnessTier(this.noaa?.timestamp ?? null, Date.parse(nowIso)) <= 1) {
          this.forecastSkill.record(Date.parse(nowIso), f.horizonHours, f.predictedKpMax, kpNow);
        }
      } catch (err) {
        console.warn("[IngestionWorker] ML Forecast failed, retaining previous predictions.");
      }
    }

    if (this.noaa?.kpReading) this.kpReading = this.noaa.kpReading;
    // Never invent variation: tiers describe the age of the real measurement.
    const tier = freshnessTier(this.noaa?.timestamp ?? null, Date.parse(nowIso));
    if (tier === 3) {
      // Past the cap the readout is unknown, not "last known"; inputs fall back to the
      // previous canonical state and the point is flagged stale.
      this.noaa = null;
    } else if (typeof this.noaa?.kp === "number") {
      // Resolve due forecasts only against a current measured Kp.
      this.forecastSkill.resolve(Date.parse(nowIso), this.noaa.kp);
    }
    const mhdInput = this.blendInputs(nowIso);
    // The solar wind reaching Earth now, from the L1 history one travel time back.
    const arriving = arrivingNow(this.l1Series, Date.parse(nowIso), gseToGsm);
    mhdInput.atEarth = arriving ? { speed: arriving.speed, bzGsm: arriving.bz, pdyn: arriving.dynamicPressure } : null;

    const { point } = await this.timing.time("nowcast", () =>
      computeCanonicalPoint(
        mhdInput,
        this.couplingWindow,
        this.previousDst,
        this.latestCanonical?.timestamp ?? null,
      ),
    );
    point.spacecraft = this.noaa?.spacecraft ?? this.latestCanonical?.spacecraft;
    point.arriving = arriving;
    if (this.kpReading) {
      point.indices.kpKind = this.kpReading.kind;
      point.indices.kpObservedAt = this.kpReading.observedAt;
    }
    if (point.indices.dstMethod === "measured" && this.kyotoDst) point.indices.dstObservedAt = this.kyotoDst.timestamp;
    point.derived = this.derivedFields();

    const densityCheck = this.noaa?.densityCheck ?? null;
    point.densityCheck = densityCheck;
    if (densityCheck) {
      // Two L1 spacecraft disagree: the true density is somewhere between them.
      const lower = Math.min(densityCheck.density, densityCheck.referenceDensity, point.solarWind.density);
      const upper = Math.max(densityCheck.density, densityCheck.referenceDensity, point.solarWind.density);
      point.uncertainty.density = { lower, upper, sigma: (upper - lower) / 2 };
      point.quality.lowConfidence = true;
    }

    if (tier > 0) {
      // Carried forward from an older measurement (tier 1) or from no measurement (tier 3).
      point.quality.stale = tier === 3;
      point.quality.extrapolated = true;
      point.quality.lowConfidence = true;
      point.quality.tier = tier;
    }

    // Measured particle flux rides along unchanged; anything older than 30 min is unknown (null).
    point.particles = {
      protons: freshReading(this.goes?.protons ?? null, nowMs),
      electrons: freshReading(this.goes?.electrons ?? null, nowMs),
    };
    // Two storm streams, kept apart: radiation (S) from protons, geomagnetic (G) from Kp (GAU-135).
    point.alerts.radiation = radiationStorm(point.particles.protons);
    point.alerts.geomagnetic = geomagneticStorm(point.indices, nowMs);
    // Radio blackouts (R) from GOES X-rays, and the input sense-checks (GAU-136).
    point.xray = freshXray(this.goes?.xray ?? null, nowMs);
    point.alerts.radioBlackout = radioBlackout(point.xray);
    point.senseChecks = this.senseChecks(point, nowMs);
    point.noaaAlerts = this.swpcProducts?.alerts ?? null;

    this.previousDst = point.indices.dst;
    this.couplingWindow.push(point.coupling.newell);
    this.trimCouplingWindow();

    const auroraMap =
      this.options.auroraGrid === false
        ? null
        : await this.timing.time("aurora-grid", () => buildAuroraGrid(point, 64)).then(({ grid, harmonics }) => ({
            timestamp: point.timestamp,
            nside: 64,
            grid,
            harmonics,
          }));

    if (mmsVector) this.latestMms = mmsVector;
    this.latestCanonical = point;
    const status = this.sourceStatus();
    if (this.options.publish !== false) await this.publish(point, auroraMap, mmsVector, status, link.mode);

    const result: IngestionTickResult = {
      canonicalPoint: point,
      mmsVector,
      sourceStatus: status,
      auroraMap,
      anomalyForecast: this.latestForecast,
    };

    return result;
  }
}
