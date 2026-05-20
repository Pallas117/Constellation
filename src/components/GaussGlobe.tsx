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
import type { LayerVisibility, EncodingMode } from './types';
import type { VisualizationParams } from '@/hooks/useSpaceWeather';

// ---------------------------------------------------------------------------
// GaussGlobe (3D viewport)
// ---------------------------------------------------------------------------

export interface GaussGlobeProps {
    layers: LayerVisibility;
    visualParams: VisualizationParams;
    encodingMode: EncodingMode;
    canvasRef: RefObject<HTMLCanvasElement | null>;
    isE2E?: boolean;
}

export function GaussGlobe({
    layers,
    visualParams,
    encodingMode,
    canvasRef,
    isE2E = false,
}: GaussGlobeProps) {
    const { magnetopauseCompression, beltIntensity, reconnectionStrength } =
        visualParams;

    if (isE2E) {
        return (
            <div
                className="absolute inset-0 bg-background/90"
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

export function EncodingPanel({
    encodingMode,
    setEncodingMode,
}: EncodingPanelProps) {
    return (
        <div
            className="hud-panel p-3 min-w-[160px] animate-fade-in-up"
            style={{ animationDelay: '0.2s' }}
        >
            <div className="scanline" />
            <h3 className="text-xs font-semibold tracking-wider text-muted-foreground mb-3 px-1">
                ENCODING
            </h3>
            <div className="space-y-1">
                <button
                    onClick={() => setEncodingMode('color')}
                    data-active={encodingMode === 'color'}
                    className="toggle-button flex items-center gap-2 w-full"
                    aria-pressed={encodingMode === 'color'}
                    aria-label="Use color encoding for radiation flux"
                >
                    <span>Color</span>
                </button>
                <button
                    onClick={() => setEncodingMode('size')}
                    data-active={encodingMode === 'size'}
                    className="toggle-button flex items-center gap-2 w-full"
                    aria-pressed={encodingMode === 'size'}
                    aria-label="Use particle size encoding for radiation flux (colorblind accessible)"
                >
                    <span>Size</span>
                </button>
                <button
                    onClick={() => setEncodingMode('both')}
                    data-active={encodingMode === 'both'}
                    className="toggle-button flex items-center gap-2 w-full"
                    aria-pressed={encodingMode === 'both'}
                    aria-label="Use both color and size encoding for radiation flux"
                >
                    <span>Both</span>
                </button>
            </div>
        </div>
    );
}
