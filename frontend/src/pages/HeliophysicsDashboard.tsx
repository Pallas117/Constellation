import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Info, Layers, PanelRight, RotateCcw, Video, Zap } from "lucide-react";
import { LayerToggles } from "@/components/ui/LayerToggles";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SpaceScene } from "@/components/scene/SpaceScene";
import { SCENE_VIEWS, type SceneView } from "@/components/scene/scene-views";
import type { MagnetosphereModelInfo } from "@/components/scene/Magnetosphere";
import { FeedStatus, HudButton, HudCluster, HudStat, SceneKey, type Tone } from "@/components/hud/Hud";
import { fmt, signed } from "@/components/hud/format";
import { GEO_RE, SceneHoverTip } from "@/components/hud/SceneHoverTip";
import { AuroraCastMap } from "@/components/heliophysics/AuroraCastMap";
import { SolarWindSpeedChart } from "@/components/heliophysics/SolarWindSpeedChart";
import { useAuroraMap } from "@/hooks/useAuroraMap";
import { useMMSReconnection } from "@/hooks/useMMSReconnection";
import { useSolarWind5s } from "@/hooks/useSolarWind5s";
import type { LayerVisibility } from "@/components/types";
import type { RadiationDataPoint } from "@/lib/types/radiation";
import mockSolarStormData from "@/data/mock_solar_storm.json";
import { beltVisuals, liveDrivers, standoffIfReference } from "@/lib/physics/live-drivers";
import { useNow } from "@/hooks/useNow";

const VIEW_KEYS = Object.keys(SCENE_VIEWS) as SceneView[];
const STORM_RADIATION = mockSolarStormData as unknown as RadiationDataPoint[];

const bzTone = (bz: number | undefined): Tone =>
  bz === undefined ? "default" : bz <= -10 ? "risk" : bz < 0 ? "caution" : "default";
const pdynTone = (p: number | undefined): Tone =>
  p === undefined ? "default" : p >= 8 ? "risk" : p >= 4 ? "caution" : "default";
const kpTone = (kp: number | undefined): Tone =>
  kp === undefined ? "default" : kp >= 7 ? "risk" : kp >= 5 ? "caution" : "default";
const utc = (t: string | number) => new Date(t).toISOString().slice(11, 16);

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
  const { drivers, plasma, arriving, densityCheck } = live;
  // The right-hand cluster shows the latest L1 reading: what reaches Earth next.
  const next = simulateStorm && drivers && plasma ? { ...drivers, ...plasma, observedAt: null, etaEarth: null } : live.l1;
  const kpValue = drivers?.kp;
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
  const travelMin = arriving
    ? fmt(arriving.travelMin, 0)
    : !simulateStorm && latest?.propagation.l1DelaySeconds
      ? fmt(latest.propagation.l1DelaySeconds / 60, 0)
      : "—";
  const etaUtc = next?.etaEarth ? utc(next.etaEarth) : null;
  const stormTier = !simulateStorm ? latest?.alerts.stormTier : undefined;
  const driversLine = simulateStorm
    ? "Simulated drivers"
    : arriving
      ? `At Earth · L1 ${utc(arriving.observedAt)} UTC · 5-min mean`
      : drivers
        ? "Latest L1 · 5-min mean · not propagated"
        : null;
  const tracedLine =
    fieldModel && driversLine
      ? `${driversLine} · ${fieldModel.tracedAt != null ? `traced ${utc(fieldModel.tracedAt)} UTC` : "tracing…"}`
      : null;
  // L1 spacecraft disagree on density: show where the magnetopause would be if the other is right.
  const r0Alt = fieldModel && densityCheck && !simulateStorm ? standoffIfReference(fieldModel.r0, densityCheck) : null;
  const r0Range = r0Alt != null && fieldModel ? [Math.min(r0Alt, fieldModel.r0), Math.max(r0Alt, fieldModel.r0)] : null;
  const densityNote = densityCheck
    ? `${densityCheck.spacecraft} reads ${fmt(densityCheck.density, 2)} cm⁻³ but ${densityCheck.reference} reads ${fmt(
        densityCheck.referenceDensity,
        2,
      )} over the last ${densityCheck.minutes} min.`
    : null;
  const kpNote =
    live.kp?.kind === "estimated-1m"
      ? "NOAA's running estimate for the current 3-hour interval, updated each minute."
      : live.kp?.kind === "planetary-3h"
        ? "The last completed 3-hour interval: this interval's running estimate is lower so far."
        : "";
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
          smoothDrivers={!simulateStorm && !live.propagated}
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
        <SceneHoverTip model={modelInfo} live={Boolean(drivers)} r0Range={r0Range} />

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
                  {r0Range && (
                    <Readout
                      label="Standoff if the other spacecraft's density is right"
                      value={`${fmt(r0Range[0])}–${fmt(r0Range[1])}`}
                      unit="RE"
                      tone="caution"
                    />
                  )}
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

                <p className="brand-label mt-6">Solar wind reaching Earth now</p>
                <dl className="mt-2">
                  <Readout label="IMF Bz (GSM)" value={signed(drivers?.bz)} unit="nT" tone={bzTone(drivers?.bz)} />
                  <Readout label="IMF By (GSM)" value={signed(drivers?.by)} unit="nT" />
                  <Readout label="Dynamic pressure" value={fmt(drivers?.pdyn, 2)} unit="nPa" tone={pdynTone(drivers?.pdyn)} />
                  <Readout label="Speed" value={fmt(plasma?.speed, 0)} unit="km/s" />
                  <Readout label="Kp" value={fmt(kpValue)} tone={kpTone(kpValue)} hint={kpNote || undefined} />
                  <Readout
                    label="Measured at L1"
                    value={arriving ? `${utc(arriving.observedAt)} UTC` : "—"}
                    hint={arriving ? `${arriving.spacecraft}, ${travelMin} min upstream` : "Not yet propagated"}
                  />
                </dl>

                <p className="brand-label mt-6">Next from L1{stormTier ? ` · ${stormTier}` : ""}</p>
                <dl className="mt-2">
                  <Readout label="IMF Bz (GSM)" value={signed(next?.bz)} unit="nT" tone={bzTone(next?.bz)} />
                  <Readout label="IMF By (GSM)" value={signed(next?.by)} unit="nT" />
                  <Readout label="Dynamic pressure" value={fmt(next?.pdyn, 2)} unit="nPa" tone={pdynTone(next?.pdyn)} />
                  <Readout label="Speed" value={fmt(next?.speed, 0)} unit="km/s" />
                  <Readout
                    label="Density"
                    value={fmt(next?.density, 2)}
                    unit={<>cm<sup>−3</sup></>}
                    tone={densityCheck ? "caution" : "default"}
                    hint={densityNote ?? undefined}
                  />
                  <Readout label="Measured" value={next?.observedAt ? `${utc(next.observedAt)} UTC` : "—"} hint={latest?.spacecraft} />
                  <Readout label="Reaches Earth" value={etaUtc ? `≈ ${etaUtc} UTC` : "—"} hint={`~${travelMin} min at this speed`} />
                  <Readout
                    label="MMS reconnection confidence"
                    value={mms.latest?.quality.confidence != null ? String(mms.latest.quality.confidence) : "—"}
                  />
                </dl>

                <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
                  NOAA SWPC real-time solar wind, 1-minute data from the operational L1 spacecraft (fill values and
                  implausible readings rejected; density cross-checked against the other L1 spacecraft). Each minute is
                  propagated ballistically to Earth (±~3 min), and the model uses the 5-minute mean of what is arriving
                  now. Shue (1998) magnetopause and Farris–Russell bow shock; field lines traced through a tilted IGRF
                  dipole, the IMF and a tail current sheet: a qualitative topology model, not a forecast.
                </p>
              </SheetContent>
            </Sheet>
          </nav>
        </header>

        {/* Bottom edge: the shield itself left, what is driving it right; stacked on phones */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-start gap-2 p-3 sm:flex-row sm:items-end sm:justify-between md:p-4">
          {/* sm:w-min: the panel is as wide as its numbers; the notes wrap under them */}
          <HudCluster label="Field model" className="max-w-full p-1.5 sm:w-min">
            <dl className="flex items-end gap-0.5">
              <HudStat
                size="lg"
                label="Magnetopause"
                value={fmt(fieldModel?.r0)}
                unit="RE"
                tone={geoExposed ? "risk" : !fieldModel || fieldModel.extrapolated || r0Range ? "caution" : "signal"}
                detail={
                  <>
                    How far sunward Earth's field holds off the solar wind (Shue 1998).{" "}
                    {geoExposed === null
                      ? "No live reading, so GEO exposure is unknown."
                      : `${geoLine}: GEO is at ${GEO_RE} RE.`}
                    {fieldModel?.extrapolated && " Drivers are outside the range the model was fitted for."}
                    {r0Range && ` ${densityNote} With the other reading it would be ${fmt(r0Alt)} RE.`}
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
            <p className="px-2 pt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
              <span className={geoExposed ? "text-sun" : geoExposed === null ? "text-caution" : undefined}>{geoLine}</span>
              {r0Range && (
                <span className="text-caution">
                  {" "}
                  · {fmt(r0Range[0])}–{fmt(r0Range[1])} RE by density
                </span>
              )}
            </p>
            {tracedLine && (
              <p className="hidden px-2 pb-0.5 pt-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/70 md:block">
                {tracedLine}
                {fieldModel?.extrapolated && <span className="text-caution"> · extrapolated</span>}
              </p>
            )}
          </HudCluster>

          <HudCluster label="Next from L1" className="p-1.5">
            <p className="px-2 pb-1 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Next from L1{etaUtc ? ` · at Earth ≈ ${etaUtc} UTC` : ""}
              {stormTier ? ` · ${stormTier}` : ""}
            </p>
            <dl className="grid grid-cols-3 gap-0.5">
              <HudStat
                label="Bz"
                value={signed(next?.bz)}
                unit="nT"
                tone={bzTone(next?.bz)}
                detail={`North–south IMF (GSM) measured at L1. Southward (negative) Bz reconnects with Earth's field and opens the dayside.${
                  arriving ? ` The scene uses the ${signed(drivers?.bz)} nT now arriving at Earth.` : ""
                }`}
              />
              <HudStat
                label="Pressure"
                value={fmt(next?.pdyn, 2)}
                unit="nPa"
                tone={densityCheck ? "caution" : pdynTone(next?.pdyn)}
                detail={`Solar wind dynamic pressure. Higher pressure compresses the magnetopause.${densityNote ? ` ${densityNote}` : ""}`}
              />
              <HudStat
                label="Kp"
                value={fmt(kpValue)}
                tone={kpTone(kpValue)}
                detail={`Planetary geomagnetic activity, 0–9. 5 and above is a storm (G1+). ${kpNote}`}
              />
              <HudStat
                className="hidden sm:block"
                label="By"
                value={signed(next?.by)}
                unit="nT"
                detail="Dawn–dusk IMF (GSM). Twists the open field lines and shifts the cusps."
              />
              <HudStat
                className="hidden sm:block"
                label="Speed"
                value={fmt(next?.speed, 0)}
                unit="km/s"
                detail={`Bulk solar wind speed. L1 to Earth takes about ${travelMin === "—" ? "an hour" : `${travelMin} min`} at this speed.`}
              />
              <HudStat
                className="hidden sm:block"
                label="Density"
                value={fmt(next?.density, 2)}
                unit={<>cm<sup>−3</sup></>}
                tone={densityCheck ? "caution" : "default"}
                detail={densityNote ? `L1 spacecraft disagree: ${densityNote}` : "Proton density. With speed, sets the dynamic pressure."}
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
