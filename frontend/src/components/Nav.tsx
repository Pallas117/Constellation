/**
 * Nav — Title branding, HUD data overlay, performance monitor, and left-rail controls.
 *
 * Owns the UI chrome that surrounds the 3D globe — everything except the
 * scene viewport itself and the bottom RAG panel.
 */

import { type RefObject, type ReactNode } from 'react';
import { HUD } from './ui/HUD';
import { LayerToggles } from './ui/LayerToggles';
import { ScreenshotButton } from './ui/ScreenshotButton';
import { PerformanceMonitor } from './ui/PerformanceMonitor';
import { ThemeSwitcher } from './ui/ThemeSwitcher';
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
            {/* Top left — Title & System State */}
            <div className="absolute top-6 left-6 p-3 bg-black/60 border-l border-primary/40 backdrop-blur-sm animate-fade-in-up">
                <h1 className="text-xl font-bold tracking-tighter text-foreground phosphor-text">
                    GAUSS // <span className="text-primary opacity-80">AURORA</span>
                </h1>
                <div className="mt-1 flex flex-col gap-0.5">
                    <p className="text-[8px] text-primary/60 uppercase tracking-[0.25em] font-bold">
                        STATE: NOMINAL_B // SSA_TRACK_ACTIVE
                    </p>
                    {spaceObjectSummary ? (
                      <p className="text-[8px] text-primary/60 uppercase tracking-[0.25em] font-bold">
                        {spaceObjectSummary}
                      </p>
                    ) : null}
                    <div className="flex items-center gap-1.5 mt-0.5 opacity-30">
                        <div className="h-[1px] w-12 bg-primary" />
                        <span className="text-[7px] text-primary uppercase tracking-[0.3em]">SKUNKWORKS_RE_09E0</span>
                    </div>
                </div>
            </div>

            {/* Top right — Data feed HUD */}
            <div className="absolute top-6 right-6 pointer-events-auto flex flex-col gap-1 items-end animate-fade-in-up">
                <HUD data={data} />
            </div>

            {/* Performance Monitor */}
            <div className="pointer-events-auto opacity-40 hover:opacity-100 transition-opacity">
                <PerformanceMonitor visible={true} />
            </div>

            {/* Left rail — Controls and actions */}
            <div className="absolute left-6 top-1/2 -translate-y-1/2 pointer-events-auto flex flex-col gap-2 items-start">
                <div className="p-1 bg-black/40 border border-primary/10 hover:border-primary/40 transition-colors">
                    <ThemeSwitcher />
                </div>
                <div className="p-1 bg-black/40 border border-primary/10 hover:border-primary/40 transition-colors">
                    <LayerToggles layers={layers} onToggle={onToggle} />
                </div>
                {children}
                <div className="p-1 bg-black/40 border border-primary/10 hover:border-primary/40 transition-colors">
                    <ScreenshotButton canvasRef={canvasRef} />
                </div>
            </div>
        </>
    );
}
