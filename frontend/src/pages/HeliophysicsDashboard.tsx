import { useMemo, useRef, useState } from "react";
import { LayerToggles } from "@/components/ui/LayerToggles";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SpaceScene } from "@/components/scene/SpaceScene";
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

/** Simulated G4: strong southward IMF behind a CME shock. */
const G4_DRIVERS: SolarWindDrivers = { bz: -20, by: 6, pdyn: 15, kp: 8 };

function formatDelay(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "n/a";
  const mins = Math.round(seconds / 60);
  return `${mins} min`;
}

const HeliophysicsDashboard = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layers, setLayers] = useState<LayerVisibility>({
    earth: true,
    belts: true,
    magnetosphere: true,
    fieldLines: true,
    mhdWaves: true,
    mmsReconnection: true,
  });

  const solarWind = useSolarWind5s();
  const mms = useMMSReconnection();
  const aurora = useAuroraMap();

  const [useMockData, setUseMockData] = useState(false);

  const latest = solarWind.latest;

  const visual = useMemo(() => {
    if (useMockData) {
      return { magnetopauseCompression: 0.5, beltIntensity: 0.9, reconnectionStrength: 0.8 };
    }
    
    const pressure = latest?.solarWind.dynamicPressure ?? 2;
    const bz = latest?.magneticField.z ?? 0;
    const kp = latest?.indices.kp ?? 2;

    const pressureNorm = Math.min(1, pressure / 10);
    const magnetopauseCompression = Math.max(0.6, 1 - pressureNorm * 0.4);
    const beltIntensity = Math.min(1, kp / 9 + 0.2);
    const reconnectionStrength = Math.max(0, Math.min(1, -bz / 15));

    return { magnetopauseCompression, beltIntensity, reconnectionStrength };
  }, [latest, useMockData]);

  const drivers = useMemo<SolarWindDrivers>(() => {
    if (useMockData) return G4_DRIVERS;
    return {
      bz: latest?.magneticField.z ?? 0,
      by: latest?.magneticField.y ?? 0,
      pdyn: latest?.solarWind.dynamicPressure ?? 2,
      kp: latest?.indices.kp ?? 2,
    };
  }, [latest, useMockData]);

  const now = useNow(60_000);
  const fieldModel = useMemo(() => {
    const { r0 } = shueMagnetopause(drivers.bz, drivers.pdyn);
    return {
      r0,
      bowShock: bowShockStandoff(r0),
      tiltDeg: (dipoleTiltRad(now) * 180) / Math.PI,
      oval: auroralOvalBounds(drivers.kp),
      // Shue (1998) was fitted for -18 < Bz < 15 nT and 0.5 < Pdyn < 8.5 nPa.
      extrapolated: drivers.bz < -18 || drivers.bz > 15 || drivers.pdyn < 0.5 || drivers.pdyn > 8.5,
    };
  }, [drivers, now]);

  const onToggle = (layer: keyof LayerVisibility) => {
    setLayers((prev) => ({
      ...prev,
      [layer]: !prev[layer],
    }));
  };

  return (
    <main className="min-h-screen w-full bg-background text-foreground relative">
      <div className="absolute top-4 left-4 z-50 space-y-2 rounded-3xl border border-primary/20 bg-black/60 p-4 text-xs text-primary shadow-lg backdrop-blur-md">
        <p className="font-semibold uppercase tracking-[0.3em]">Open Magnetohydrodynamics</p>
        <p>Public explorers and contributors can access this SDA-enabled visualization without operator login.</p>
      </div>
      <button 
        onClick={() => {
          setUseMockData(!useMockData);
          // Broadcast a custom event so the RAG panel can pick it up
          window.dispatchEvent(new CustomEvent('simulate-g4-storm', { detail: !useMockData }));
        }}
        className={`absolute top-4 right-4 z-50 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest transition-colors ${useMockData ? 'bg-red-600 text-white animate-pulse' : 'bg-primary/20 text-primary hover:bg-primary/30'}`}
      >
        {useMockData ? "Reset Scene" : "Simulate G4 Storm"}
      </button>

      <section className="grid gap-4 p-4 pt-14 lg:grid-cols-[1fr_320px]">
        <div className="relative h-[460px] overflow-hidden rounded-lg border bg-black lg:h-[620px]">
          <SpaceScene
            layers={layers}
            magnetopauseCompression={visual.magnetopauseCompression}
            beltIntensity={visual.beltIntensity}
            reconnectionStrength={visual.reconnectionStrength}
            mmsVectors={mms.vectors}
            solarWindDrivers={drivers}
            canvasRef={canvasRef}
            data={useMockData ? mockSolarStormData as any : undefined}
            orbitFilter={['LEO', 'MEO', 'GEO']}
          />
        </div>

        <div className="space-y-4">
          <LayerToggles layers={layers} onToggle={onToggle} />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Field Model</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
                <dt className="text-muted-foreground">Magnetopause standoff</dt>
                <dd className="font-semibold">
                  {fieldModel.r0.toFixed(1)} R<sub>E</sub>
                  {fieldModel.extrapolated && (
                    <span className="ml-1 text-xs text-[hsl(var(--amber))]" title="Drivers outside the Shue (1998) fit range">
                      extrap.
                    </span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Bow shock nose</dt>
                <dd className="font-semibold">{fieldModel.bowShock.toFixed(1)} R<sub>E</sub></dd>
                <dt className="text-muted-foreground">Dipole tilt</dt>
                <dd className="font-semibold">{fieldModel.tiltDeg >= 0 ? "+" : ""}{fieldModel.tiltDeg.toFixed(1)}°</dd>
                <dt className="text-muted-foreground">Aurora equatorward edge</dt>
                <dd className="font-semibold">{fieldModel.oval.equatorward.toFixed(0)}° MLAT</dd>
                <dt className="text-muted-foreground">GEO exposed to sheath</dt>
                <dd className={fieldModel.r0 < 6.6 ? "font-semibold text-destructive" : "font-semibold"}>
                  {fieldModel.r0 < 6.6 ? "Yes" : "No"}
                </dd>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                Shue (1998) magnetopause; field lines traced through a tilted IGRF dipole, IMF and tail sheet.
                Cyan lines are closed, amber lines are open to the solar wind.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Operational Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                Storm tier: <span className="font-semibold">{latest?.alerts.stormTier ?? "unknown"}</span>
              </p>
              <p>
                IMF Bz: <span className="font-semibold">{latest?.magneticField.z.toFixed(2) ?? "0.00"} nT</span>
              </p>
              <p>
                L1 Delay: <span className="font-semibold">{formatDelay(latest?.propagation.l1DelaySeconds)}</span>
              </p>
              <p>
                Reconnection confidence:{" "}
                <span className="font-semibold">{mms.latest?.quality.confidence ?? "n/a"}</span>
              </p>
              <p>
                Feed mode: <span className="font-semibold">{solarWind.source}</span>
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="grid gap-4 p-4 lg:grid-cols-2">
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
