import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useSpaceWeather } from '@/hooks/useSpaceWeather';
import { GaussGlobe } from '@/components/GaussGlobe';
import { SceneBoundary } from '@/components/ErrorBoundary';
import { PilotPanels } from '@/components/PilotPanels';
import { Readout, Meter, KpMeter } from '@/components/brand/Readout';
import { StatusBadge } from '@/components/brand/StatusBadge';
import { Button } from '@/components/ui/button';
import { useSession } from '@/lib/auth-client';
import { bzStatus, feedState, FEED_LABEL, kpStatus, speedStatus } from '@/lib/readout-status';

const LANDING_LAYERS = {
  earth: true,
  belts: true,
  magnetosphere: true,
  fieldLines: true,
  mhdWaves: false,
  mmsReconnection: false,
};

function utcTime(d: Date) {
  return `${d.toISOString().slice(11, 16)} UTC`;
}

export default function PublicDashboard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { data, visualParams } = useSpaceWeather();
  const { data: session } = useSession();
  const signedIn = Boolean(session?.user?.id);

  const isE2E =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('e2e');

  const feed = feedState(data);
  const measured = feed !== 'unavailable';
  const speed = data.solarWind.speed;
  const bz = data.imfBz;
  const kp = data.kpIndex;
  const speedSt = measured ? speedStatus(speed) : null;
  const kpSt = measured ? kpStatus(kp) : null;
  const bzSt = measured ? bzStatus(bz) : null;

  const bzNote = !measured
    ? 'Live solar wind data is currently unavailable.'
    : feed === 'stale'
      ? 'Last measurement is more than 15 minutes old.'
      : bz <= -5
        ? 'Southward IMF is enabling magnetic reconnection and potential storm activity.'
        : 'IMF is stable. Magnetosphere is currently shielded from major solar wind coupling.';

  return (
    <div className="relative h-dvh w-screen overflow-hidden bg-background text-foreground">
      {/* 3D scene behind everything; the middle column stays clear on desktop */}
      <div className="absolute inset-0 z-0">
        <SceneBoundary>
          <GaussGlobe
            layers={LANDING_LAYERS}
            visualParams={visualParams}
            encodingMode="color"
            canvasRef={canvasRef}
            isE2E={isE2E}
          />
        </SceneBoundary>
      </div>
      {/* Scrims keep header and footer text legible over the field lines */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-56 bg-gradient-to-b from-background via-background/70 to-transparent" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-24 bg-gradient-to-t from-background/90 to-transparent" />

      <div className="pointer-events-none absolute inset-0 z-10 overflow-y-auto">
        <div className="flex min-h-full flex-col gap-6 p-4 sm:p-6 lg:p-8">
          <header className="pointer-events-auto flex flex-wrap items-start justify-between gap-4 animate-fade-in-up">
            <div className="max-w-md">
              <p className="brand-label">00_LIVE · SPACE WEATHER</p>
              <h1 className="mt-1 text-3xl font-semibold leading-tight sm:text-4xl">Gauss Aurora</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground sm:text-base">
                Real-time monitoring of Earth's magnetosphere. Protecting critical orbital and terrestrial
                infrastructure from space weather anomalies.
              </p>
            </div>
            <nav aria-label="Main" className="flex flex-wrap items-center gap-2">
              <Button asChild variant="ghost">
                <Link to="/member">Member hub</Link>
              </Button>
              {signedIn && (
                <Button asChild variant="ghost">
                  <Link to="/account/api">API keys</Link>
                </Button>
              )}
              <Button asChild variant="outline">
                <Link to="/operator">
                  <Lock aria-hidden="true" />
                  Operator portal
                </Link>
              </Button>
            </nav>
          </header>

          {/* On phones, a window onto the scene before the readouts */}
          <div aria-hidden="true" className="h-[38vh] shrink-0 lg:hidden" />

          <main className="grid flex-1 content-end gap-6 lg:grid-cols-[minmax(0,360px)_1fr_minmax(0,340px)] lg:items-end">
            <section aria-label="Live solar wind" className="pointer-events-auto flex flex-col gap-3 animate-fade-in-up">
              <Readout
                label="Solar wind speed"
                value={measured ? String(Math.round(speed)) : '—'}
                unit="km/s"
                status={speedSt}
                meter={speedSt && <Meter fraction={(speed - 300) / 500} tone={speedSt.tone} label="Solar wind speed, 300 to 800 km/s" />}
              />
              <Readout
                label="Geomagnetic activity (Kp)"
                value={measured ? kp.toFixed(1) : '—'}
                unit="/ 9"
                status={kpSt}
                meter={kpSt && <KpMeter kp={kp} tone={kpSt.tone} />}
              />
              <Readout
                label="IMF Bz"
                value={measured ? `${bz > 0 ? '+' : ''}${bz.toFixed(1)}` : '—'}
                unit="nT"
                status={bzSt}
                note={bzNote}
              />
            </section>

            <div aria-hidden="true" className="hidden lg:block" />

            <aside aria-label="Pilot offers" className="pointer-events-auto animate-fade-in-up">
              <PilotPanels />
            </aside>
          </main>

          <footer className="pointer-events-auto flex flex-wrap items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
            <span>
              Source: NOAA Space Weather Prediction Center
              {measured && <> · measured {utcTime(data.timestamp)}</>}
            </span>
            <StatusBadge tone={feed === 'live' ? 'signal' : 'caution'} pulse={feed === 'live'}>
              {FEED_LABEL[feed]}
            </StatusBadge>
          </footer>
        </div>
      </div>
    </div>
  );
}
