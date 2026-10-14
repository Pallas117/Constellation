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
import { Switch } from './ui/switch';
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

      {/* UI overlays: placed around the scene from md up; on a phone, one scrolling
          column under a strip of the scene, so no panel covers another. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 overflow-y-auto px-3 pb-6 pt-[38vh] md:block md:overflow-visible md:p-0">
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
          <div className="hud-panel flex min-h-10 w-full items-center justify-between gap-3 bg-panel/85 px-3 backdrop-blur-md">
            <label htmlFor="hifi-belts" className="cursor-pointer text-sm">
              High-fidelity belts
            </label>
            <Switch id="hifi-belts" checked={highFidelityBelts} onCheckedChange={setHighFidelityBelts} />
          </div>
        </Nav>

        <ReasoningStream />
        <div className="pointer-events-none flex flex-col gap-2 md:absolute md:bottom-6 md:right-6 md:items-end">
          <UndetectedObjectsAlert alert={spaceObjectAlert} />
          <DataFlowHUD tier={data.tier} />
        </div>
      </div>
    </div>
  );
};
