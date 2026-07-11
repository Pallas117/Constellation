/**
 * SpaceWeatherVisualization — Thin orchestrator.
 *
 * Owns top-level state (layers, encoding mode) and composes the three atomic
 * components: GaussGlobe, Nav, and ReasoningStream.
 */

import { useState, useRef, useCallback } from 'react';
import { useSpaceWeather } from '@/hooks/useSpaceWeather';
import { useSpaceObjects } from '@/hooks/useSpaceObjects';
import { GaussGlobe, EncodingPanel } from './GaussGlobe';
import { Nav } from './Nav';
import { ReasoningStream } from './ReasoningStream';
import { DataFlowHUD } from './DataFlowHUD';
import { UndetectedObjectsAlert } from './UndetectedObjectsAlert';
import type { LayerVisibility, EncodingMode } from './types';

export const SpaceWeatherVisualization = () => {
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

  // ---- Render --------------------------------------------------------------
  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* 3D Scene */}
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

      {/* UI Overlays */}
      <div className="absolute inset-0 pointer-events-none">
        <Nav
          data={data}
          layers={layers}
          onToggle={handleToggle}
          canvasRef={canvasRef}
          spaceObjectSummary={
            spaceObjectAlert
              ? `UNTRACKED OBJECTS DETECTED: ${spaceObjectAlert.candidateCount}`
              : `KNOWN ORBITAL ASSETS: ${spaceObjects?.length ?? 0}`
          }
        >
          <EncodingPanel
            encodingMode={encodingMode}
            setEncodingMode={setEncodingMode}
          />
          <div className="absolute right-4 top-4 pointer-events-auto">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={highFidelityBelts}
                onChange={(e) => setHighFidelityBelts(e.target.checked)}
                className="form-checkbox"
              />
              <span>High-fidelity belts</span>
            </label>
          </div>
        </Nav>

        <ReasoningStream />
        <DataFlowHUD tier={data.tier} />
        <UndetectedObjectsAlert alert={spaceObjectAlert} />
      </div>
    </div>
  );
};
