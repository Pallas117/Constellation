/**
 * Operator console chrome: the header bar and the left control rail.
 *
 * Each sits in its own grid cell in SpaceWeatherVisualization, so nothing
 * overlaps at any width. The scene viewport, telemetry column and assistant
 * live alongside.
 */

import { type ReactNode, type RefObject } from 'react';
import { LayerToggles } from './ui/LayerToggles';
import { ScreenshotButton } from './ui/ScreenshotButton';
import { PerformanceMonitor } from './ui/PerformanceMonitor';
import { StatusBadge } from './brand/StatusBadge';
import { FEED_LABEL, type FeedState } from '@/lib/readout-status';
import type { LayerVisibility } from './types';

export function ConsoleHeader({
    feed,
    summary,
    actions,
}: {
    feed: FeedState;
    /** One line under the title, e.g. tracked-object count. */
    summary?: string;
    /** Page-specific links and status pills. */
    actions?: ReactNode;
}) {
    return (
        <header className="pointer-events-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-charcoal bg-panel/95 px-4 py-3 animate-fade-in-up">
            <div className="min-w-0">
                <p className="brand-label">01_OPERATOR_CONSOLE</p>
                <h1 className="text-xl font-semibold leading-tight">Gauss Aurora</h1>
                {summary && <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                {actions}
                <PerformanceMonitor />
                {/* The one lime element in the console: is the feed live? */}
                <StatusBadge tone={feed === 'live' ? 'signal' : 'caution'} pulse={feed === 'live'}>
                    {FEED_LABEL[feed]}
                </StatusBadge>
            </div>
        </header>
    );
}

export function ControlRail({
    layers,
    onToggle,
    canvasRef,
    children,
}: {
    layers: LayerVisibility;
    onToggle: (layer: keyof LayerVisibility) => void;
    canvasRef: RefObject<HTMLCanvasElement | null>;
    /** Extra controls after the layer switches (encoding, fidelity). */
    children?: ReactNode;
}) {
    return (
        <nav aria-label="Scene controls" className="pointer-events-auto flex flex-col gap-2 animate-fade-in-up">
            <LayerToggles layers={layers} onToggle={onToggle} label="02_LAYERS" />
            {children}
            <ScreenshotButton canvasRef={canvasRef} />
        </nav>
    );
}
