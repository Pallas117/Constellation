import { useMemo, useRef, useState, type ReactNode } from "react";
import { Zap, RotateCcw } from "lucide-react";
import { LayerToggles } from "@/components/ui/LayerToggles";
import { SpaceScene, SCENE_VIEWS, type SceneView } from "@/components/scene/SpaceScene";
import { AuroraCastMap } from "@/components/heliophysics/AuroraCastMap";
import { SolarWindSpeedChart } from "@/components/heliophysics/SolarWindSpeedChart";
import { useAuroraMap } from "@/hooks/useAuroraMap";
import { useMMSReconnection } from "@/hooks/useMMSReconnection";
import { useSolarWind5s } from "@/hooks/useSolarWind5s";
import type { LayerVisibility } from "@/components/types";
import mockSolarStormData from "@/data/mock_solar_storm.json";
import {
  auroralOvalBounds,
  bowShockStandoff,
  dipoleTiltRad,
  shueMagnetopause,
  type SolarWindDrivers,
} from "@/lib/physics/geomagnetic";
import { useNow } from "@/hooks/useNow";

/** Simulated G4: strong southward IMF behind a CME shock (Pdyn = 1.67e-6·n·v² ≈ 15 nPa). */
const G4_DRIVERS: SolarWindDrivers = { bz: -20, by: 6, pdyn: 15, kp: 8 };
const G4_PLASMA = { speed: 670, density: 20 };

/** Geostationary orbit radius, Re. */
const GEO_RE = 6.6;
const STALE_AFTER_MIN = 15;

type FeedMode = "live" | "stale" | "none" | "simulated";

const fmt = (v: number | null | undefined, digits = 1) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
const signed = (v: number | null | undefined, digits = 1) =>
  typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(digits)}` : "—";

/* ------------------------------------------------------------------------- */

const FEED_STYLES: Record<FeedMode, { label: string; className: string; dot: string }> = {
  live: { label: "Live L1 drivers", className: "border-charcoal text-foreground", dot: "bg-signal" },
  stale: { label: "Stale drivers", className: "border-caution/60 text-caution", dot: "bg-caution" },
  none: { label: "No live data · reference geometry", className: "border-caution/60 text-caution", dot: "bg-caution" },
  simulated: { label: "Simulated G4 storm", className: "border-sun/70 text-sun", dot: "bg-sun" },
};

function FeedStatus({ mode, ageMin, className = "" }: { mode: FeedMode; ageMin: number | null; className?: string }) {
  const style = FEED_STYLES[mode];
  const age = ageMin === null ? "" : ` · ${ageMin < 1 ? "<1" : Math.round(ageMin)} min old`;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-full border bg-black/70 px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.12em] backdrop-blur ${style.className} ${className}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {style.label}
      {age}
    </div>
  );
}

function Panel({ label, title, children, aside }: { label: string; title: string; children: ReactNode; aside?: ReactNode }) {
  const id = `panel-${label}`;
  return (
    <section className="hud-panel p-4" aria-labelledby={id}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="brand-label">{label}</p>
          <h2 id={id} className="mt-1 text-base font-semibold leading-snug">
            {title}
          </h2>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Readout({ label, value, unit, tone = "default", hint }: { label: string; value: string; unit?: ReactNode; tone?: "default" | "caution" | "risk"; hint?: string }) {
  const toneClass = tone === "risk" ? "text-sun" : tone === "caution" ? "text-caution" : "text-foreground";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-charcoal py-1.5 last:border-b-0" title={hint}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={`font-mono text-sm tabular-nums ${toneClass}`}>
        {value}
        {unit && value !== "—" && <span className="ml-1 text-xs text-muted-foreground">{unit}</span>}
      </dd>
    </div>
  );
}

function Legend() {
  const items: { label: string; swatch: string }[] = [
    { label: "Closed field line", swatch: "bg-gradient-to-r from-foreground to-earth" },
    { label: "Open to solar wind", swatch: "bg-gradient-to-r from-caution to-sun" },
    { label: "Magnetopause", swatch: "bg-earth" },
    { label: "Inner belt · protons", swatch: "bg-caution" },
    { label: "Outer belt · electrons, aurora", swatch: "bg-signal" },
  ];
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-10 hidden rounded-md border border-charcoal bg-black/75 p-3 backdrop-blur sm:block">
      <p className="brand-label mb-2 text-[10px]">Key</p>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.label} className="flex items-center gap-2 text-xs text-foreground/90">
            <span aria-hidden="true" className={`h-1 w-5 rounded-full ${i.swatch}`} />
            {i.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

const HeliophysicsDashboard = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layers, setLayers] = useState<LayerVisibility>({
    earth: true,
    belts: true,
    magnetosphere: true,
    fieldLines: true,
    mhdWaves: false,
    mmsReconnection: true,
  });
  const [view, setView] = useState<SceneView>("overview");
  const [viewRequest, setViewRequest] = useState(0);

  const solarWind = useSolarWind5s();
  const mms = useMMSReconnection();
  const aurora = useAuroraMap();

  const [simulateStorm, setSimulateStorm] = useState(false);
  const latest = solarWind.latest;
  const now = useNow(60_000);

  // Fail closed: without a fresh reading the scene shows reference geometry and
  // the readouts show "—", never nominal numbers presented as live.
  const feed = useMemo((): { mode: FeedMode; ageMin: number | null } => {
    if (simulateStorm) return { mode: "simulated", ageMin: null };
    if (!latest) return { mode: "none", ageMin: null };
    const ageMin = Math.max(0, (now - Date.parse(latest.timestamp)) / 60_000);
    const stale = latest.quality.stale || !Number.isFinite(ageMin) || ageMin > STALE_AFTER_MIN;
    return { mode: stale ? "stale" : "live", ageMin: Number.isFinite(ageMin) ? ageMin : null };
  }, [latest, simulateStorm, now]);

  const drivers = useMemo<SolarWindDrivers | undefined>(() => {
    if (simulateStorm) return G4_DRIVERS;
    if (!latest) return undefined;
    return {
      bz: latest.magneticField.z,
      by: latest.magneticField.y,
      pdyn: latest.solarWind.dynamicPressure,
      kp: latest.indices.kp,
    };
  }, [latest, simulateStorm]);

  const plasma = simulateStorm ? G4_PLASMA : latest ? { speed: latest.solarWind.speed, density: latest.solarWind.density } : null;

  // Legacy normalised params still drive the belts; reference values when no data.
  const visual = useMemo(() => {
    const pressure = drivers?.pdyn ?? 2;
    const bz = drivers?.bz ?? 0;
    const kp = drivers?.kp ?? 2;
    return {
      magnetopauseCompression: Math.max(0.6, 1 - Math.min(1, pressure / 10) * 0.4),
      beltIntensity: Math.min(1, kp / 9 + 0.2),
      reconnectionStrength: Math.max(0, Math.min(1, -bz / 15)),
    };
  }, [drivers]);

  const fieldModel = useMemo(() => {
    if (!drivers) return null;
    const { r0 } = shueMagnetopause(drivers.bz, drivers.pdyn);
    return {
      r0,
      bowShock: bowShockStandoff(r0),
      oval: auroralOvalBounds(drivers.kp),
      // Shue (1998) was fitted for -18 < Bz < 15 nT and 0.5 < Pdyn < 8.5 nPa.
      extrapolated: drivers.bz < -18 || drivers.bz > 15 || drivers.pdyn < 0.5 || drivers.pdyn > 8.5,
    };
  }, [drivers]);
  const tiltDeg = useMemo(() => (dipoleTiltRad(now) * 180) / Math.PI, [now]);
  const geoExposed = fieldModel ? fieldModel.r0 < GEO_RE : null;

  const onToggle = (layer: keyof LayerVisibility) => setLayers((prev) => ({ ...prev, [layer]: !prev[layer] }));

  const toggleStorm = () => {
    const next = !simulateStorm;
    setSimulateStorm(next);
    // The RAG panel listens for this to narrate the scenario.
    window.dispatchEvent(new CustomEvent("simulate-g4-storm", { detail: next }));
  };

  const chooseView = (v: SceneView) => {
    setView(v);
    setViewRequest((n) => n + 1);
  };

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <header className="border-b border-charcoal">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-end justify-between gap-4 px-4 py-5 md:px-6">
          <div className="min-w-0">
            <p className="brand-label">04_HELIOPHYSICS · GAUSS AURORA</p>
            <h1 className="mt-2 text-balance text-2xl font-semibold leading-tight md:text-3xl">
              Earth's magnetic shield, driven by the live solar wind.
            </h1>
            <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
              Field lines are traced from L1 solar wind measurements. Use “Simulate G4 storm” to see a severe event.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FeedStatus mode={feed.mode} ageMin={feed.ageMin} />
            <button
              type="button"
              onClick={toggleStorm}
              aria-pressed={simulateStorm}
              className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                simulateStorm
                  ? "border-sun bg-sun/15 text-sun hover:bg-sun/25"
                  : "border-charcoal bg-panel text-foreground hover:bg-secondary"
              }`}
            >
              {simulateStorm ? <RotateCcw size={14} aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}
              {simulateStorm ? "Back to live" : "Simulate G4 storm"}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] gap-4 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section
          aria-label="3D magnetosphere"
          className="relative h-[min(72vh,700px)] min-h-[380px] overflow-hidden rounded-lg border border-charcoal bg-black"
        >
          <SpaceScene
            layers={layers}
            magnetopauseCompression={visual.magnetopauseCompression}
            beltIntensity={visual.beltIntensity}
            reconnectionStrength={visual.reconnectionStrength}
            mmsVectors={mms.vectors}
            solarWindDrivers={drivers}
            view={view}
            viewRequest={viewRequest}
            canvasRef={canvasRef}
            data={simulateStorm ? (mockSolarStormData as any) : undefined}
            orbitFilter={["LEO", "MEO", "GEO"]}
          />

          <div className="absolute inset-x-3 top-3 z-10 flex items-start justify-between gap-3">
            <div
              role="toolbar"
              aria-label="Camera view"
              className="flex max-w-full gap-1 overflow-x-auto rounded-md border border-charcoal bg-black/75 p-1 backdrop-blur"
            >
              {(Object.keys(SCENE_VIEWS) as SceneView[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => chooseView(v)}
                  className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    view === v ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {SCENE_VIEWS[v].label}
                </button>
              ))}
            </div>
            <p className="hidden rounded-md bg-black/60 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground xl:block">
              Drag to orbit · scroll to zoom · R resets · Sun is to the right
            </p>
          </div>

          <FeedStatus mode={feed.mode} ageMin={feed.ageMin} className="pointer-events-none absolute bottom-3 left-3 z-10" />
          <Legend />
        </section>

        <aside className="space-y-4">
          <Panel
            label="01_FIELD_MODEL"
            title="How far out the shield stands"
            aside={
              fieldModel?.extrapolated ? (
                <span
                  className="rounded-full border border-caution/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-caution"
                  title="Drivers are outside the range the Shue (1998) model was fitted for"
                >
                  Extrapolated
                </span>
              ) : undefined
            }
          >
            <div className="mb-3 flex items-baseline gap-2">
              <span className={`font-mono text-4xl font-bold tabular-nums ${geoExposed ? "text-sun" : "text-signal"}`}>
                {fmt(fieldModel?.r0)}
              </span>
              <span className="text-sm text-muted-foreground">
                R<sub>E</sub> magnetopause standoff
              </span>
            </div>
            <p className={`mb-3 text-sm ${geoExposed ? "text-sun" : geoExposed === null ? "text-caution" : "text-muted-foreground"}`}>
              {geoExposed === null
                ? "No live reading: GEO exposure unknown."
                : geoExposed
                  ? `Inside GEO (${GEO_RE} RE): geostationary satellites are in the solar wind.`
                  : `Outside GEO (${GEO_RE} RE): geostationary satellites are shielded.`}
            </p>
            <dl>
              <Readout label="Bow shock nose" value={fmt(fieldModel?.bowShock)} unit={<>R<sub>E</sub></>} />
              <Readout label="Aurora equatorward edge" value={fmt(fieldModel?.oval.equatorward, 0)} unit="° MLAT" />
              <Readout label="Dipole tilt" value={signed(tiltDeg)} unit="°" hint="Angle of the magnetic axis toward the Sun; from the UTC clock" />
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Shue (1998) magnetopause. Field lines traced through a tilted IGRF dipole, the IMF and a tail current sheet:
              a qualitative topology model, not a forecast.
            </p>
          </Panel>

          <Panel label="02_DRIVERS" title="Solar wind at L1" aside={latest?.alerts.stormTier && !simulateStorm ? (
            <span className="rounded-full border border-charcoal px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {latest.alerts.stormTier}
            </span>
          ) : undefined}>
            <dl>
              <Readout
                label="IMF Bz"
                value={signed(drivers?.bz)}
                unit="nT"
                tone={drivers && drivers.bz <= -10 ? "risk" : drivers && drivers.bz < 0 ? "caution" : "default"}
                hint="Southward (negative) Bz opens the dayside magnetopause to reconnection"
              />
              <Readout label="IMF By" value={signed(drivers?.by)} unit="nT" />
              <Readout
                label="Dynamic pressure"
                value={fmt(drivers?.pdyn)}
                unit="nPa"
                tone={drivers && drivers.pdyn >= 8 ? "risk" : drivers && drivers.pdyn >= 4 ? "caution" : "default"}
              />
              <Readout label="Speed" value={fmt(plasma?.speed, 0)} unit="km/s" />
              <Readout label="Density" value={fmt(plasma?.density)} unit={<>cm<sup>−3</sup></>} />
              <Readout label="Kp" value={fmt(drivers?.kp)} tone={drivers && drivers.kp >= 7 ? "risk" : drivers && drivers.kp >= 5 ? "caution" : "default"} />
              <Readout
                label="L1 → Earth delay"
                value={!simulateStorm && latest?.propagation.l1DelaySeconds ? fmt(latest.propagation.l1DelaySeconds / 60, 0) : "—"}
                unit="min"
              />
              <Readout label="MMS reconnection confidence" value={mms.latest?.quality.confidence != null ? String(mms.latest.quality.confidence) : "—"} />
            </dl>
          </Panel>

          <LayerToggles layers={layers} onToggle={onToggle} label="03_LAYERS" />
        </aside>
      </div>

      <div className="mx-auto grid max-w-[1600px] gap-4 px-4 pb-8 md:px-6 lg:grid-cols-2">
        <SolarWindSpeedChart
          points={solarWind.points}
          loading={solarWind.loading}
          error={solarWind.error}
          source={solarWind.source}
        />
        <AuroraCastMap map={aurora.map} loading={aurora.loading} error={aurora.error} />
      </div>
    </main>
  );
};

export default HeliophysicsDashboard;
