import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, KeyRound, Lock, Orbit } from 'lucide-react';
import { motion } from 'framer-motion';
import { GaussGlobe } from '@/components/GaussGlobe';
import { SceneBoundary } from '@/components/ErrorBoundary';
import { PilotPanels } from '@/components/PilotPanels';
import type { MagnetosphereModelInfo } from '@/components/scene/Magnetosphere';
import { FeedStatus, HudCluster, HudStat } from '@/components/hud/Hud';
import { fmt, signed } from '@/components/hud/format';
import { GEO_RE, SceneHoverTip } from '@/components/hud/SceneHoverTip';
import { useSolarWind5s } from '@/hooks/useSolarWind5s';
import { useNow } from '@/hooks/useNow';
import { useSession } from '@/lib/auth-client';
import { beltVisuals, liveDrivers, standoffIfReference } from '@/lib/physics/live-drivers';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

const LAYERS = {
  earth: true,
  belts: true,
  magnetosphere: true,
  fieldLines: true,
  mhdWaves: false,
  mmsReconnection: false,
};

const NAV_LINK =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-charcoal/70 bg-black/55 px-2.5 text-xs font-medium text-foreground/90 backdrop-blur-md transition-colors hover:bg-white/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const fadeIn = (delay: number) => ({
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: 0.8, delay, ease: 'easeOut' as const },
});

export default function PublicDashboard() {
  useDocumentTitle();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { data: session } = useSession();
  const signedIn = Boolean(session?.user?.id);
  const [modelInfo, setModelInfo] = useState<MagnetosphereModelInfo | null>(null);

  // The public latest L1 point, once a minute, drives the traced field lines.
  const solarWind = useSolarWind5s({ history: false });
  const now = useNow(60_000);
  const live = useMemo(() => liveDrivers(solarWind.latest, now), [solarWind.latest, now]);
  const { drivers, plasma, arriving } = live;
  const visualParams = useMemo(() => beltVisuals(drivers), [drivers]);
  const r0 = drivers && modelInfo ? modelInfo.r0 : null;
  const geoExposed = r0 === null ? null : r0 < GEO_RE;
  // Same honesty as /heliophysics: a disputed density gives a range, and Shue (1998)
  // was only fitted for 0.5-8.5 nPa and -18 < Bz < 15 nT.
  const alt = r0 !== null && live.densityCheck ? standoffIfReference(r0, live.densityCheck) : null;
  const r0Range = alt !== null && r0 !== null ? [Math.min(alt, r0), Math.max(alt, r0)] : null;
  const used = modelInfo?.drivers;
  const extrapolated = Boolean(used && (used.bz < -18 || used.bz > 15 || used.pdyn < 0.5 || used.pdyn > 8.5));

  const isE2E = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e');

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-black font-sans text-foreground">
      <div className="absolute inset-0 z-0">
        <SceneBoundary>
          <GaussGlobe
            layers={LAYERS}
            visualParams={visualParams}
            encodingMode="color"
            canvasRef={canvasRef}
            isE2E={isE2E}
            solarWindDrivers={drivers}
            smoothDrivers={!live.propagated}
            onModelUpdate={setModelInfo}
            hoverable
          />
        </SceneBoundary>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(ellipse_at_center,transparent_55%,hsl(var(--background)/0.8)_100%)]"
      />
      <SceneHoverTip model={modelInfo} live={Boolean(drivers)} />

      {/* Top edge: identity left, navigation right */}
      <motion.header
        {...fadeIn(0)}
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-3 md:p-5"
      >
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Gauss Aurora</h1>
          <p className="max-w-[34ch] text-xs leading-relaxed text-muted-foreground md:text-sm">
            Earth's magnetic shield, traced live from the solar wind.
          </p>
          <FeedStatus mode={live.mode} ageMin={live.ageMin} />
        </div>
        <nav aria-label="Main" className="pointer-events-auto flex flex-wrap items-center justify-end gap-1.5">
          {signedIn && (
            <Link to="/heliophysics" className={NAV_LINK}>
              <Orbit className="h-3.5 w-3.5" aria-hidden="true" />
              Field model
            </Link>
          )}
          <Link to="/operator" className={NAV_LINK}>
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            Operator Portal
          </Link>
          <Link to="/member" className={NAV_LINK}>
            <Globe className="h-3.5 w-3.5" aria-hidden="true" />
            Member Hub
          </Link>
          {signedIn && (
            <Link to="/account/api" className={NAV_LINK}>
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              API keys
            </Link>
          )}
        </nav>
      </motion.header>

      {/* Bottom edge: live readouts left, pilot offers right */}
      <motion.div
        {...fadeIn(0.4)}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-start gap-2 p-3 md:flex-row md:items-end md:justify-between md:p-5"
      >
        <HudCluster label="Live readouts" className="p-1.5">
          <dl className="flex flex-wrap items-end gap-0.5">
            <HudStat
              size="lg"
              label="Magnetopause"
              value={fmt(r0)}
              unit="RE"
              tone={geoExposed ? 'risk' : r0 === null || r0Range || extrapolated ? 'caution' : 'signal'}
              detail={
                r0 === null
                  ? 'How far sunward Earth’s field holds off the solar wind. No live reading: the scene shows reference geometry.'
                  : `How far sunward Earth’s field holds off the solar wind. ${
                      geoExposed ? 'Inside' : 'Outside'
                    } geostationary orbit (${GEO_RE} RE): GEO satellites are ${geoExposed ? 'exposed' : 'shielded'}.${
                      r0Range
                        ? ` The L1 spacecraft disagree on density, so it is ${fmt(r0Range[0])}–${fmt(r0Range[1])} RE depending on which is right.`
                        : ''
                    }${extrapolated ? ' The solar wind is outside the range the model was fitted for.' : ''}`
              }
            />
            <HudStat
              label="Solar wind"
              value={fmt(plasma?.speed, 0)}
              unit="km/s"
              detail="Bulk speed of the solar wind reaching Earth now, measured at L1 about 45 min earlier."
            />
            <HudStat
              label="IMF Bz"
              value={signed(drivers?.bz)}
              unit="nT"
              tone={drivers ? (drivers.bz <= -10 ? 'risk' : drivers.bz < 0 ? 'caution' : 'default') : 'default'}
              detail={
                !drivers
                  ? 'Live solar wind data is unavailable.'
                  : drivers.bz < -5
                    ? 'Southward IMF is reconnecting with Earth’s field: storm conditions are possible.'
                    : 'Northward or weak IMF: the magnetosphere is mostly closed to the solar wind.'
              }
            />
            <HudStat
              label="Kp"
              value={fmt(drivers?.kp)}
              tone={drivers ? (drivers.kp >= 7 ? 'risk' : drivers.kp >= 5 ? 'caution' : 'default') : 'default'}
              detail="Planetary geomagnetic activity, 0–9. 5 and above is a storm (G1+)."
            />
          </dl>
          <p className="px-2 pb-0.5 pt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
            {arriving
              ? `Solar wind reaching Earth · L1 ${new Date(arriving.observedAt).toISOString().slice(11, 16)} UTC`
              : "NOAA SWPC · L1"}
            <span className="hidden md:inline"> · point at the scene for detail</span>
          </p>
        </HudCluster>

        <PilotPanels className="max-w-full" />
      </motion.div>
    </div>
  );
}
