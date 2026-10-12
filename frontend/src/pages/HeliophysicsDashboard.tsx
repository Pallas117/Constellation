import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Info, Layers, PanelRight, RotateCcw, Video, Zap } from "lucide-react";
import { LayerToggles } from "@/components/ui/LayerToggles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SpaceScene, SCENE_VIEWS, type SceneView } from "@/components/scene/SpaceScene";
import type { MagnetosphereModelInfo } from "@/components/scene/Magnetosphere";
import { FeedStatus, HudButton, HudCluster, HudStat, SceneKey, fmt, signed, type Tone } from "@/components/hud/Hud";
import { GEO_RE, SceneHoverTip } from "@/components/hud/SceneHoverTip";
import { AuroraCastMap } from "@/components/heliophysics/AuroraCastMap";
import { SolarWindSpeedChart } from "@/components/heliophysics/SolarWindSpeedChart";
import { useAuroraMap } from "@/hooks/useAuroraMap";
import { useMMSReconnection } from "@/hooks/useMMSReconnection";
import { useSolarWind5s } from "@/hooks/useSolarWind5s";
import type { LayerVisibility } from "@/components/types";
import type { RadiationDataPoint } from "@/lib/types/radiation";
import mockSolarStormData from "@/data/mock_solar_storm.json";
import { beltVisuals, liveDrivers } from "@/lib/physics/live-drivers";
import { useNow } from "@/hooks/useNow";

const VIEW_KEYS = Object.keys(SCENE_VIEWS) as SceneView[];
const STORM_RADIATION = mockSolarStormData as unknown as RadiationDataPoint[];

const bzTone = (bz: number | undefined): Tone =>
  bz === undefined ? "default" : bz <= -10 ? "risk" : bz < 0 ? "caution" : "default";
const pdynTone = (p: number | undefined): Tone =>
  p === undefined ? "default" : p >= 8 ? "risk" : p >= 4 ? "caution" : "default";
const kpTone = (kp: number | undefined): Tone =>
  kp === undefined ? "default" : kp >= 7 ? "risk" : kp >= 5 ? "caution" : "default";

/* ------------------------------------------------------------------------- */
/* Details drawer: the full readouts and method, for touch and deep reading  */

function Readout({ label, value, unit, tone = "default", hint }: { label: string; value: string; unit?: ReactNode; tone?: Tone; hint?: string }) {
  const toneClass = tone === "risk" ? "text-sun" : tone === "caution" ? "text-caution" : "text-foreground";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-charcoal py-1.5 last:border-b-0">
      <dt className="text-sm text-muted-foreground">
        {label}
        {hint && <span className="block text-xs text-muted-foreground/70">{hint}</span>}
      </dt>
      <dd className={`shrink-0 font-mono text-sm tabular-nums ${toneClass}`}>
        {value}
        {unit && value !== "—" && <span className="ml-1 text-xs text-muted-foreground">{unit}</span>}
      </dd>
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
  const [modelInfo, setModelInfo] = useState<MagnetosphereModelInfo | null>(null);
  const [simulateStorm, setSimulateStorm] = useState(false);

  const solarWind = useSolarWind5s();
  const mms = useMMSReconnection();
  const aurora = useAuroraMap();
  const latest = solarWind.latest;
  const now = useNow(60_000);

  // Fail closed: without a fresh reading the scene shows reference geometry and
  // the readouts show "—", never nominal numbers presented as live.
  const live = useMemo(() => liveDrivers(latest, now, simulateStorm), [latest, now, simulateStorm]);
  const { drivers, plasma } = live;
  const visual = useMemo(() => beltVisuals(drivers), [drivers]);

  // The HUD describes exactly what the scene drew: the traced model, built
  // from 5-min mean drivers for live data.
  const fieldModel = useMemo(() => {
    if (!drivers || !modelInfo) return null;
    const used = modelInfo.drivers;
    return {
      ...modelInfo,
      // Shue (1998) was fitted for -18 < Bz < 15 nT and 0.5 < Pdyn < 8.5 nPa.
      extrapolated: used.bz < -18 || used.bz > 15 || used.pdyn < 0.5 || used.pdyn > 8.5,
    };
  }, [drivers, modelInfo]);
  const geoExposed = fieldModel ? fieldModel.r0 < GEO_RE : null;
  const tiltDeg = modelInfo ? (modelInfo.tilt * 180) / Math.PI : null;
  const openPct = fieldModel?.openFraction != null ? `${Math.round(fieldModel.openFraction * 100)}` : "—";
  const l1DelayMin =
    !simulateStorm && latest?.propagation.l1DelaySeconds ? fmt(latest.propagation.l1DelaySeconds / 60, 0) : "—";
  const stormTier = !simulateStorm ? latest?.alerts.stormTier : undefined;
  const tracedLine = fieldModel
    ? `${fieldModel.smoothed ? "5-min mean" : "Simulated"} · ${
        fieldModel.tracedAt != null ? `traced ${new Date(fieldModel.tracedAt).toISOString().slice(11, 16)} UTC` : "tracing…"
      }`
    : null;
  const geoLine =
    geoExposed === null
      ? "GEO exposure unknown"
      : geoExposed
        ? "Inside GEO · satellites exposed"
        : "Outside GEO · satellites shielded";

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

  // 1-5 pick a camera view, like a HUD's preset keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'][data-state='open']")) return;
      const v = VIEW_KEYS[Number(e.key) - 1];
      if (!v) return;
      setView(v);
      setViewRequest((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="w-full bg-background text-foreground">
      <section aria-label="3D magnetosphere" className="relative h-[100dvh] min-h-[540px] w-full overflow-hidden bg-black">
        <SpaceScene
          layers={layers}
          magnetopauseCompression={visual.magnetopauseCompression}
          beltIntensity={visual.beltIntensity}
          reconnectionStrength={visual.reconnectionStrength}
          mmsVectors={mms.vectors}
          solarWindDrivers={drivers}
          smoothDrivers={!simulateStorm}
          onModelUpdate={setModelInfo}
          view={view}
          viewRequest={viewRequest}
          canvasRef={canvasRef}
          data={simulateStorm ? STORM_RADIATION : undefined}
          orbitFilter={["LEO", "MEO", "GEO"]}
          hoverable
        />
        {/* Edge vignette so HUD text reads without boxing in the field lines */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,hsl(var(--background)/0.8)_100%)]"
        />
        <SceneHoverTip model={modelInfo} live={Boolean(drivers)} />

        {/* Top edge: identity and feed left, controls right */}
        <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3 md:p-4">
          <div className="flex min-w-0 flex-col items-start gap-1.5">
            <Link to="/" className="brand-label pointer-events-auto text-[10px]">
              Gauss Aurora<span className="hidden sm:inline"> · Heliophysics</span>
            </Link>
            <h1 className="text-sm font-semibold leading-tight text-foreground/90 md:text-base">
              Earth's magnetic shield, live
            </h1>
            <FeedStatus mode={live.mode} ageMin={live.ageMin} />
          </div>

          <nav aria-label="Scene controls" className="pointer-events-auto flex shrink-0 items-center gap-1.5">
            <Popover>
              <PopoverTrigger asChild>
                <HudButton label={`Camera view: ${SCENE_VIEWS[view].label}`} hint="Camera view · keys 1–5">
                  <Video size={14} aria-hidden="true" />
                  <span className="hidden sm:inline">{SCENE_VIEWS[view].label}</span>
                </HudButton>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-52 border-charcoal bg-panel/95 p-1 backdrop-blur-md">
                <ul aria-label="Camera view">
                  {VIEW_KEYS.map((v, i) => (
                    <li key={v}>
                      <button
                        type="button"
                        aria-pressed={view === v}
                        onClick={() => chooseView(v)}
                        className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          view === v ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {SCENE_VIEWS[v].label}
                        <kbd className="font-mono text-[10px] text-muted-foreground">{i + 1}</kbd>
                      </button>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <HudButton label="Layers">
                  <Layers size={14} aria-hidden="true" />
                </HudButton>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 border-0 bg-transparent p-0 shadow-none">
                <LayerToggles layers={layers} onToggle={onToggle} label="Layers" />
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <HudButton label="Colour key and controls">
                  <Info size={14} aria-hidden="true" />
                </HudButton>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 border-charcoal bg-panel/95 p-3 backdrop-blur-md">
                <p className="brand-label mb-2 text-[10px]">Key</p>
                <SceneKey />
                <p className="mt-3 border-t border-charcoal pt-2 text-xs leading-relaxed text-muted-foreground">
                  Drag to orbit, scroll to zoom, 1–5 for views, R to reset. Point at Earth or a boundary for its live
                  value. The Sun is to the right.
                </p>
              </PopoverContent>
            </Popover>

            <HudButton
              label={simulateStorm ? "Back to live" : "Simulate G4 storm"}
              hint={simulateStorm ? "Return to the live L1 drivers" : "Show a severe (G4) storm: Bz −20 nT, 15 nPa, Kp 8"}
              aria-pressed={simulateStorm}
              active={simulateStorm}
              tone="sun"
              onClick={toggleStorm}
            >
              {simulateStorm ? <RotateCcw size={14} aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}
              <span className="hidden sm:inline">{simulateStorm ? "Back to live" : "Simulate G4"}</span>
            </HudButton>

            <Sheet>
              <SheetTrigger asChild>
                <HudButton label="Details">
                  <PanelRight size={14} aria-hidden="true" />
                </HudButton>
              </SheetTrigger>
              <SheetContent side="right" className="w-full overflow-y-auto border-charcoal bg-panel sm:max-w-sm">
                <SheetHeader className="text-left">
                  <p className="brand-label">Field model</p>
                  <SheetTitle>How far out the shield stands</SheetTitle>
                  <SheetDescription>{geoLine}.</SheetDescription>
                </SheetHeader>
                <dl className="mt-4">
                  <Readout label="Magnetopause standoff" value={fmt(fieldModel?.r0)} unit="RE" tone={geoExposed ? "risk" : "default"} />
                  <Readout label="Bow shock nose" value={fmt(fieldModel?.bowShock)} unit="RE" />
                  <Readout label="Aurora equatorward edge" value={fmt(fieldModel?.oval.equatorward, 0)} unit="° MLAT" />
                  <Readout label="Dipole tilt" value={signed(tiltDeg)} unit="°" hint="Toward the Sun, from the UTC clock" />
                  <Readout label="Field lines open to the solar wind" value={openPct} unit="%" />
                </dl>
                {tracedLine && (
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {tracedLine}
                    {fieldModel?.extrapolated && <span className="ml-2 text-caution">· extrapolated</span>}
                  </p>
                )}

                <p className="brand-label mt-6">Solar wind at L1{stormTier ? ` · ${stormTier}` : ""}</p>
                <dl className="mt-2">
                  <Readout label="IMF Bz" value={signed(drivers?.bz)} unit="nT" tone={bzTone(drivers?.bz)} />
                  <Readout label="IMF By" value={signed(drivers?.by)} unit="nT" />
                  <Readout label="Dynamic pressure" value={fmt(drivers?.pdyn)} unit="nPa" tone={pdynTone(drivers?.pdyn)} />
                  <Readout label="Speed" value={fmt(plasma?.speed, 0)} unit="km/s" />
                  <Readout label="Density" value={fmt(plasma?.density)} unit={<>cm<sup>−3</sup></>} />
                  <Readout label="Kp" value={fmt(drivers?.kp)} tone={kpTone(drivers?.kp)} />
                  <Readout label="L1 → Earth delay" value={l1DelayMin} unit="min" />
                  <Readout
                    label="MMS reconnection confidence"
                    value={mms.latest?.quality.confidence != null ? String(mms.latest.quality.confidence) : "—"}
                  />
                </dl>

                <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
                  Shue (1998) magnetopause and Farris–Russell bow shock. Field lines are traced through a tilted IGRF
                  dipole, the IMF and a tail current sheet: a qualitative topology model, not a forecast. Geometry uses
                  the 5-minute mean of the drivers, as the model was fitted, and retraces only on meaningful changes.
                </p>
              </SheetContent>
            </Sheet>
          </nav>
        </header>

        {/* Bottom edge: the shield itself left, what is driving it right; stacked on phones */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-start gap-2 p-3 sm:flex-row sm:items-end sm:justify-between md:p-4">
          <HudCluster label="Field model" className="max-w-full p-1.5">
            <dl className="flex items-end gap-0.5">
              <HudStat
                size="lg"
                label="Magnetopause"
                value={fmt(fieldModel?.r0)}
                unit="RE"
                tone={geoExposed ? "risk" : fieldModel ? "signal" : "caution"}
                detail={
                  <>
                    How far sunward Earth's field holds off the solar wind (Shue 1998).{" "}
                    {geoExposed === null
                      ? "No live reading, so GEO exposure is unknown."
                      : `${geoLine}: GEO is at ${GEO_RE} RE.`}
                    {fieldModel?.extrapolated && " Drivers are outside the range the model was fitted for."}
                  </>
                }
              />
              <HudStat
                className="hidden sm:block"
                label="Bow shock"
                value={fmt(fieldModel?.bowShock)}
                unit="RE"
                detail="Where the supersonic solar wind slows, upstream of the magnetopause (Farris–Russell)."
              />
              <HudStat
                className="hidden sm:block"
                label="Open lines"
                value={openPct}
                unit="%"
                detail="Share of traced field lines connected to the solar wind. Grows as southward Bz opens the magnetosphere."
              />
              <HudStat
                className="hidden sm:block"
                label="Aurora edge"
                value={fmt(fieldModel?.oval.equatorward, 0)}
                unit="° MLAT"
                detail="Equatorward edge of the auroral oval, from Kp."
              />
              <HudStat
                className="hidden sm:block"
                label="Tilt"
                value={signed(tiltDeg)}
                unit="°"
                detail="Angle of the magnetic axis toward the Sun, from the UTC clock."
              />
            </dl>
            <p className="px-2 pb-0.5 pt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
              <span className={geoExposed ? "text-sun" : geoExposed === null ? "text-caution" : undefined}>{geoLine}</span>
              {tracedLine && <span className="hidden md:inline"> · {tracedLine}</span>}
              {fieldModel?.extrapolated && <span className="text-caution"> · extrapolated</span>}
            </p>
          </HudCluster>

          <HudCluster label="Solar wind at L1" className="p-1.5">
            <p className="px-2 pb-1 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Solar wind · L1{stormTier ? ` · ${stormTier}` : ""}
            </p>
            <dl className="grid grid-cols-3 gap-0.5">
              <HudStat
                label="Bz"
                value={signed(drivers?.bz)}
                unit="nT"
                tone={bzTone(drivers?.bz)}
                detail="North–south IMF. Southward (negative) Bz reconnects with Earth's field and opens the dayside."
              />
              <HudStat
                label="Pressure"
                value={fmt(drivers?.pdyn)}
                unit="nPa"
                tone={pdynTone(drivers?.pdyn)}
                detail="Solar wind dynamic pressure. Higher pressure compresses the magnetopause."
              />
              <HudStat
                label="Kp"
                value={fmt(drivers?.kp)}
                tone={kpTone(drivers?.kp)}
                detail="Planetary geomagnetic activity, 0–9. 5 and above is a storm (G1+)."
              />
              <HudStat
                className="hidden sm:block"
                label="By"
                value={signed(drivers?.by)}
                unit="nT"
                detail="Dawn–dusk IMF. Twists the open field lines and shifts the cusps."
              />
              <HudStat
                className="hidden sm:block"
                label="Speed"
                value={fmt(plasma?.speed, 0)}
                unit="km/s"
                detail={`Bulk solar wind speed. L1 to Earth takes about ${l1DelayMin === "—" ? "an hour" : `${l1DelayMin} min`} at this speed.`}
              />
              <HudStat
                className="hidden sm:block"
                label="Density"
                value={fmt(plasma?.density)}
                unit={<>cm<sup>−3</sup></>}
                detail="Proton density. With speed, sets the dynamic pressure."
              />
            </dl>
          </HudCluster>
        </div>

        <a
          href="#history"
          className="pointer-events-auto absolute bottom-4 left-1/2 z-10 hidden -translate-x-1/2 items-center gap-1 rounded-full px-3 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex"
        >
          24 h history <ChevronDown size={12} aria-hidden="true" />
        </a>
      </section>

      <section id="history" aria-label="History" className="mx-auto grid max-w-[1600px] gap-4 p-4 md:p-6 lg:grid-cols-2">
        <SolarWindSpeedChart
          points={solarWind.points}
          loading={solarWind.loading}
          error={solarWind.error}
          source={solarWind.source}
        />
        <AuroraCastMap map={aurora.map} loading={aurora.loading} error={aurora.error} />
      </section>
    </main>
  );
};

export default HeliophysicsDashboard;
