/**
 * Hook for managing Level-of-Detail (LOD) for 3D rendering
 * Automatically adjusts LOD based on performance metrics
 * 
 * Note: Client-side hook
 */

import { useState, useEffect, useCallback } from 'react';
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

  const [lodLevel, setLODLevelState] = useState(initialLOD);

  // Monitor performance
  const { metrics } = usePerformanceMonitor({
    datasetSize,
    fpsThreshold: targetFPS,
    enabled: autoAdjust,
  });

  // Auto-adjust LOD based on performance
  useEffect(() => {
    if (!autoAdjust) return;

    let newLOD = lodLevel;

    // If FPS is below target, increase LOD (reduce detail)
    if (metrics.fps < targetFPS - 5) {
      newLOD = Math.min(lodLevel + 1, LOD_LEVELS.length - 1);
    }
    // If FPS is well above target and dataset is small, decrease LOD (increase detail)
    else if (metrics.fps > targetFPS + 10 && datasetSize < LOD_LEVELS[lodLevel].maxPoints) {
      newLOD = Math.max(lodLevel - 1, 0);
    }

    if (newLOD !== lodLevel) {
      setLODLevelState(newLOD);
    }
  }, [autoAdjust, metrics.fps, targetFPS, datasetSize, lodLevel]);

  // Auto-adjust based on dataset size
  useEffect(() => {
    if (!autoAdjust) return;

    // Find appropriate LOD for dataset size
    for (let i = LOD_LEVELS.length - 1; i >= 0; i--) {
      if (datasetSize <= LOD_LEVELS[i].maxPoints) {
        if (i !== lodLevel) {
          setLODLevelState(i);
        }
        break;
      }
    }
  }, [autoAdjust, datasetSize, lodLevel]);

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

