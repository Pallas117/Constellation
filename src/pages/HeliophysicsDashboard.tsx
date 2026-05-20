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

  const onToggle = (layer: keyof LayerVisibility) => {
    setLayers((prev) => ({
      ...prev,
      [layer]: !prev[layer],
    }));
  };

  return (
    <main className="min-h-screen w-full bg-background text-foreground relative">
      <button 
        onClick={() => {
          setUseMockData(!useMockData);
          // Broadcast a custom event so the RAG panel can pick it up
          window.dispatchEvent(new CustomEvent('simulate-g4-storm', { detail: !useMockData }));
        }}
        className={`absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest transition-colors ${useMockData ? 'bg-red-600 text-white animate-pulse' : 'bg-primary/20 text-primary hover:bg-primary/30'}`}
      >
        {useMockData ? "Reset Scene" : "Simulate G4 Storm"}
      </button>

      <section className="grid gap-4 p-4 pt-14 lg:grid-cols-[1fr_320px]">
        <div className="relative h-[420px] overflow-hidden rounded-lg border bg-card">
          <SpaceScene
            layers={layers}
            magnetopauseCompression={visual.magnetopauseCompression}
            beltIntensity={visual.beltIntensity}
            reconnectionStrength={visual.reconnectionStrength}
            mmsVectors={mms.vectors}
            canvasRef={canvasRef}
            data={useMockData ? mockSolarStormData as any : undefined}
            orbitFilter={['LEO', 'MEO', 'GEO']}
          />
        </div>

        <div className="space-y-4">
          <LayerToggles layers={layers} onToggle={onToggle} />
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
