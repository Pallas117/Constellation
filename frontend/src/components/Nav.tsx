/**
 * Nav — title, sensor readout and left-rail controls (frame-rate monitor in development only).
 *
 * Owns the UI chrome that surrounds the 3D globe — everything except the
 * scene viewport itself and the bottom RAG panel.
 */

import { type RefObject, type ReactNode } from 'react';
import { HUD } from './ui/HUD';
import { LayerToggles } from './ui/LayerToggles';
import { ScreenshotButton } from './ui/ScreenshotButton';
import { PerformanceMonitor } from './ui/PerformanceMonitor';
import type { LayerVisibility } from './types';
import type { InterpolatedData } from '@/hooks/useSpaceWeather';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NavProps {
    data: InterpolatedData;
    layers: LayerVisibility;
    onToggle: (layer: keyof LayerVisibility) => void;
    canvasRef: RefObject<HTMLCanvasElement | null>;
    spaceObjectSummary?: string;
    /** Slot for extra controls rendered after LayerToggles (e.g. encoding panel) */
    children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Nav({
    data,
    layers,
    onToggle,
    canvasRef,
    spaceObjectSummary,
    children,
}: NavProps) {
    return (
        <>
            {/* Top left — title */}
            <div className="hud-panel pointer-events-auto bg-panel/85 px-4 py-3 backdrop-blur-md md:absolute md:left-6 md:top-6">
                <h1 className="brand-label">00_OPERATOR · GAUSS AURORA</h1>
                {spaceObjectSummary ? <p className="stat-label mt-2">{spaceObjectSummary}</p> : null}
            </div>

            {/* Top right — Data feed HUD */}
            <div className="pointer-events-auto flex flex-col gap-1 md:absolute md:right-6 md:top-6 md:items-end">
                <HUD data={data} />
            </div>

            {/* Frame-rate readout: a development aid, not part of the console. */}
            {import.meta.env.DEV && (
                <div className="pointer-events-auto opacity-40 transition-opacity hover:opacity-100">
                    <PerformanceMonitor visible={true} />
                </div>
            )}

            {/* Left rail — Controls and actions */}
            <div className="pointer-events-auto flex flex-col gap-2 md:absolute md:left-6 md:top-1/2 md:-translate-y-1/2 md:items-start">
                <LayerToggles layers={layers} onToggle={onToggle} label="01_LAYERS" />
                {children}
                <ScreenshotButton canvasRef={canvasRef} />
            </div>
        </>
    );
}
