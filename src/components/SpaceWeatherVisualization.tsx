/**
 * SpaceWeatherVisualization — Thin orchestrator.
 *
 * Owns top-level state (layers, encoding mode) and composes the three atomic
 * components: GaussGlobe, Nav, and ReasoningStream.
 */

import { useState, useRef, useCallback } from 'react';
import { useSpaceWeather } from '@/hooks/useSpaceWeather';
import { GaussGlobe, EncodingPanel } from './GaussGlobe';
import { Nav } from './Nav';
import { ReasoningStream } from './ReasoningStream';
import { DataFlowHUD } from './DataFlowHUD';
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

  const { data, visualParams } = useSpaceWeather();

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
        isE2E={isE2E}
      />

      {/* UI Overlays */}
      <div className="absolute inset-0 pointer-events-none">
        <Nav
          data={data}
          layers={layers}
          onToggle={handleToggle}
          canvasRef={canvasRef}
        >
          <EncodingPanel
            encodingMode={encodingMode}
            setEncodingMode={setEncodingMode}
          />
        </Nav>

        <ReasoningStream />
        <DataFlowHUD tier={data.tier} />
      </div>
    </div>
  );
};
