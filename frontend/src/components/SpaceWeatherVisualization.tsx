/**
 * SpaceWeatherVisualization — the operator console.
 *
 * Owns top-level state (layers, encoding mode) and lays the console out in
 * fixed regions over the 3D scene: header, left control rail, right
 * telemetry column and the assistant under the scene. On small screens the
 * regions stack and scroll; telemetry comes first.
 */

import { useState, useRef, useCallback, type ReactNode } from 'react';
import { useSpaceWeather } from '@/hooks/useSpaceWeather';
import { useSpaceObjects } from '@/hooks/useSpaceObjects';
import { GaussGlobe, EncodingPanel } from './GaussGlobe';
import { ConsoleHeader, ControlRail } from './Nav';
import { HUD } from './ui/HUD';
import { ReasoningStream } from './ReasoningStream';
import { DataFlowHUD } from './DataFlowHUD';
import { UndetectedObjectsAlert } from './UndetectedObjectsAlert';
import { SceneBoundary } from './ErrorBoundary';
import { feedState } from '@/lib/readout-status';
import type { LayerVisibility, EncodingMode } from './types';

function FidelitySwitch({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="hud-panel p-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium leading-tight">High-fidelity belts</span>
          <span className="block truncate text-xs text-muted-foreground">More particles, more GPU</span>
        </span>
        <span
          aria-hidden="true"
          className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors ${on ? 'border-foreground/70 bg-foreground/15' : 'border-charcoal'}`}
        >
          <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full transition-all ${on ? 'left-3.5 bg-foreground' : 'left-0.5 bg-muted-foreground'}`} />
        </span>
      </button>
    </div>
  );
}

export const SpaceWeatherVisualization = ({ headerActions }: { headerActions?: ReactNode }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isE2E =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('e2e');

  // ---- State ---------------------------------------------------------------
  const [layers, setLayers] = useState<LayerVisibility>({
    earth: true,
    belts: true,
    magnetosphere: true,
    fieldLines: true,
    mhdWaves: true,
    mmsReconnection: false,
  });

  const [encodingMode, setEncodingMode] = useState<EncodingMode>('color');
  const [highFidelityBelts, setHighFidelityBelts] = useState(false);

  const { data, visualParams } = useSpaceWeather();
  const { catalog: spaceObjects, alert: spaceObjectAlert } = useSpaceObjects(data);

  const handleToggle = useCallback((layer: keyof LayerVisibility) => {
    setLayers(prev => ({ ...prev, [layer]: !prev[layer] }));
  }, []);

  const summary = spaceObjectAlert
    ? `${spaceObjectAlert.candidateCount} untracked object${spaceObjectAlert.candidateCount === 1 ? '' : 's'} detected`
    : `${spaceObjects?.length ?? 0} known orbital assets tracked`;

  // ---- Render --------------------------------------------------------------
  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* 3D scene */}
      <SceneBoundary>
        <GaussGlobe
          layers={layers}
          visualParams={visualParams}
          encodingMode={encodingMode}
          canvasRef={canvasRef}
          spaceObjects={spaceObjects}
          spaceObjectAlert={spaceObjectAlert}
          isE2E={isE2E}
          highFidelityBelts={highFidelityBelts}
        />
      </SceneBoundary>

      {/* Console regions. The overlay ignores the pointer so the scene can be
          dragged between panels; each panel opts back in. */}
      <div className="pointer-events-none absolute inset-0 overflow-y-auto lg:overflow-hidden">
        <div className="flex min-h-full flex-col gap-3 p-3 sm:p-4 lg:grid lg:h-full lg:grid-cols-[264px_minmax(0,1fr)_320px] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-4">
          <div className="lg:col-span-3">
            <ConsoleHeader feed={feedState(data)} summary={summary} actions={headerActions} />
          </div>

          <aside
            aria-label="Telemetry"
            className="pointer-events-auto flex flex-col gap-3 lg:col-start-3 lg:row-start-2 lg:min-h-0 lg:overflow-y-auto"
          >
            <HUD data={data} />
            <UndetectedObjectsAlert alert={spaceObjectAlert} />
            <DataFlowHUD tier={data.tier} />
          </aside>

          {/* Scene stays visible here; the assistant sits at its foot */}
          <div className="flex flex-col items-center justify-end lg:col-start-2 lg:row-start-2 lg:min-h-0">
            {/* On phones, a window onto the scene between telemetry and the assistant */}
            <div aria-hidden="true" className="h-[45vh] lg:hidden" />
            <div className="pointer-events-auto flex w-full justify-center lg:max-h-full lg:overflow-y-auto">
              <ReasoningStream />
            </div>
          </div>

          <div className="lg:col-start-1 lg:row-start-2 lg:min-h-0 lg:overflow-y-auto">
            <ControlRail layers={layers} onToggle={handleToggle} canvasRef={canvasRef}>
              <EncodingPanel encodingMode={encodingMode} setEncodingMode={setEncodingMode} />
              <FidelitySwitch on={highFidelityBelts} onChange={setHighFidelityBelts} />
            </ControlRail>
          </div>
        </div>
      </div>
    </div>
  );
};
