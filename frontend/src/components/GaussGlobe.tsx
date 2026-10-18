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

const ENCODINGS: { mode: EncodingMode; label: string; aria: string }[] = [
    { mode: 'color', label: 'Colour', aria: 'Use color encoding for radiation flux' },
    { mode: 'size', label: 'Size', aria: 'Use particle size encoding for radiation flux (colorblind accessible)' },
    { mode: 'both', label: 'Both', aria: 'Use both color and size encoding for radiation flux' },
];

export function EncodingPanel({
    encodingMode,
    setEncodingMode,
}: EncodingPanelProps) {
    return (
        <section className="hud-panel p-3" aria-labelledby="encoding-label">
            <h2 id="encoding-label" className="mb-2 font-mono text-xs uppercase tracking-[0.06em] text-muted-foreground">
                Flux encoding
            </h2>
            <div role="group" aria-labelledby="encoding-label" className="grid grid-cols-3 gap-0.5 rounded-md border border-charcoal p-0.5">
                {ENCODINGS.map(({ mode, label, aria }) => (
                    <button
                        key={mode}
                        type="button"
                        onClick={() => setEncodingMode(mode)}
                        aria-pressed={encodingMode === mode}
                        aria-label={aria}
                        className={`rounded px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            encodingMode === mode ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>
        </section>
    );
}
