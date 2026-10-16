/**
 * Hook for managing Level-of-Detail (LOD) for 3D rendering
 * Automatically adjusts LOD based on performance metrics
 * 
 * Note: Client-side hook
 */

import { useState, useCallback } from 'react';
import { usePerformanceMonitor } from './usePerformanceMonitor';

export interface UseLODOptions {
  /** Initial LOD level (0 = highest, 3 = lowest) */
  initialLOD?: number;
  /** Enable automatic LOD adjustment */
  autoAdjust?: boolean;
  /** Dataset size threshold for LOD adjustment */
  datasetSize?: number;
  /** Target FPS (default: 60) */
  targetFPS?: number;
}

export interface UseLODReturn {
  /** Current LOD level */
  lodLevel: number;
  /** Set LOD level manually */
  setLODLevel: (level: number) => void;
  /** Maximum points to render at current LOD */
  maxPoints: number;
  /** Point size multiplier at current LOD */
  pointSize: number;
}

const LOD_LEVELS = [
  { maxPoints: Infinity, pointSize: 1.0 }, // LOD 0: All points
  { maxPoints: 50000, pointSize: 0.8 }, // LOD 1: 50k points
  { maxPoints: 20000, pointSize: 0.6 }, // LOD 2: 20k points
  { maxPoints: 5000, pointSize: 0.4 }, // LOD 3: 5k points
];

export function useLOD(options: UseLODOptions = {}): UseLODReturn {
  const {
    initialLOD = 0,
    autoAdjust = true,
    datasetSize = 0,
    targetFPS = 60,
  } = options;

  const [manualLOD, setLODLevelState] = useState(initialLOD);

  // Monitor performance
  const { metrics } = usePerformanceMonitor({
    datasetSize,
    fpsThreshold: targetFPS,
    enabled: autoAdjust,
  });

  // Auto mode derives the level each render: the coarsest level that still holds the whole
  // dataset, one level coarser while FPS is below target. (Two effects used to set it; the
  // dataset effect undid every FPS step, so a slow scene re-rendered in a loop.)
  let lodLevel = manualLOD;
  if (autoAdjust) {
    lodLevel = LOD_LEVELS.length - 1;
    while (lodLevel > 0 && datasetSize > LOD_LEVELS[lodLevel].maxPoints) lodLevel--;
    if (metrics.fps < targetFPS - 5) lodLevel = Math.min(lodLevel + 1, LOD_LEVELS.length - 1);
  }

  const setLODLevel = useCallback((level: number) => {
    const clamped = Math.max(0, Math.min(level, LOD_LEVELS.length - 1));
    setLODLevelState(clamped);
  }, []);

  const currentLOD = LOD_LEVELS[Math.min(lodLevel, LOD_LEVELS.length - 1)];

  return {
    lodLevel,
    setLODLevel,
    maxPoints: currentLOD.maxPoints,
    pointSize: currentLOD.pointSize,
  };
}

