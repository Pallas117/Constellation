/**
 * GaussGlobe — 3D scene viewport + encoding mode selector.
 *
 * Exports two sub-components:
 *  • GaussGlobe    — the Three.js scene (or e2e placeholder)
 *  • EncodingPanel — Color / Size / Both toggle group
 *
 * They are kept in the same file because encoding directly controls how the
 * scene renders particles, but they can be laid out independently by the
 * parent orchestrator.
 */

import { type RefObject } from 'react';
import { SpaceScene } from './scene/SpaceScene';
import type { MagnetosphereModelInfo } from './scene/Magnetosphere';
import type { SolarWindDrivers } from '@/lib/physics/geomagnetic';
import type { LayerVisibility, EncodingMode } from './types';
import type { VisualizationParams } from '@/hooks/useSpaceWeather';
import type { SpaceObjectCatalogEntry, SpaceObjectDetectionAlert } from '@/lib/types/space-object';

// ---------------------------------------------------------------------------
// GaussGlobe (3D viewport)
// ---------------------------------------------------------------------------

export interface GaussGlobeProps {
    layers: LayerVisibility;
    visualParams: Pick<VisualizationParams, 'magnetopauseCompression' | 'beltIntensity' | 'reconnectionStrength'>;
    encodingMode: EncodingMode;
    canvasRef: RefObject<HTMLCanvasElement | null>;
    spaceObjects?: SpaceObjectCatalogEntry[];
    spaceObjectAlert?: SpaceObjectDetectionAlert | null;
    isE2E?: boolean;
    highFidelityBelts?: boolean;
    /** Live drivers for the traced field lines; reference geometry without them. */
    solarWindDrivers?: SolarWindDrivers;
    /** Average the drivers over 5 min before tracing; off when they are already means. */
    smoothDrivers?: boolean;
    onModelUpdate?: (info: MagnetosphereModelInfo) => void;
    hoverable?: boolean;
}

export function GaussGlobe({
    layers,
    visualParams,
    encodingMode,
    canvasRef,
    spaceObjects,
    spaceObjectAlert,
    isE2E = false,
    highFidelityBelts = false,
    solarWindDrivers,
    smoothDrivers = true,
    onModelUpdate,
    hoverable = false,
}: GaussGlobeProps) {
    const { magnetopauseCompression, beltIntensity, reconnectionStrength } =
        visualParams;

    if (isE2E) {
        return (
            <canvas
                ref={canvasRef}
                width={1600}
                height={900}
                className="absolute inset-0 w-full h-full bg-background/90"
                aria-label="3d scene disabled for e2e"
            />
        );
    }

    return (
        <SpaceScene
            layers={layers}
            magnetopauseCompression={magnetopauseCompression}
            beltIntensity={beltIntensity}
            reconnectionStrength={reconnectionStrength}
            canvasRef={canvasRef}
            encodingMode={encodingMode}
            spaceObjects={spaceObjects}
            spaceObjectAlert={spaceObjectAlert}
            highFidelity={highFidelityBelts}
            solarWindDrivers={solarWindDrivers}
            smoothDrivers={smoothDrivers}
            onModelUpdate={onModelUpdate}
            hoverable={hoverable}
        />
    );
}

// ---------------------------------------------------------------------------
// EncodingPanel (Color / Size / Both toggle)
// ---------------------------------------------------------------------------

export interface EncodingPanelProps {
    encodingMode: EncodingMode;
    setEncodingMode: (mode: EncodingMode) => void;
}

const ENCODINGS: { mode: EncodingMode; label: string; description: string }[] = [
    { mode: 'color', label: 'Colour', description: 'Colour shows radiation flux' },
    { mode: 'size', label: 'Size', description: 'Particle size shows radiation flux (colour-blind safe)' },
    { mode: 'both', label: 'Both', description: 'Colour and size show radiation flux' },
];

export function EncodingPanel({
    encodingMode,
    setEncodingMode,
}: EncodingPanelProps) {
    return (
        <div className="hud-panel w-full bg-panel/85 p-3 backdrop-blur-md">
            <p id="encoding-label" className="stat-label mb-2">Flux encoding</p>
            <div role="radiogroup" aria-labelledby="encoding-label" className="grid grid-cols-3 gap-1 rounded-md border border-border p-0.5">
                {ENCODINGS.map(({ mode, label, description }) => (
                    <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={encodingMode === mode}
                        title={description}
                        onClick={() => setEncodingMode(mode)}
                        className={`min-h-8 rounded px-2 text-xs transition-colors ${
                            encodingMode === mode
                                ? 'bg-foreground text-background'
                                : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );
}
