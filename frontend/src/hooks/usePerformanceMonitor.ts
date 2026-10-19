/**
 * Hook to monitor FPS and dataset size for performance warnings
 */

import { useState, useEffect, useMemo } from 'react';

export interface PerformanceMetrics {
  fps: number;
  frameTime: number;
  avgFrameTime: number;
  datasetSize: number;
  isLowFPS: boolean; // Below 60fps
  isLargeDataset: boolean; // Dataset too large
}

export interface UsePerformanceMonitorOptions {
  /** Dataset size to monitor */
  datasetSize?: number;
  /** FPS threshold for warnings (default: 60) */
  fpsThreshold?: number;
  /** Dataset size threshold for warnings (default: 50000) */
  datasetThreshold?: number;
  /** Enable monitoring */
  enabled?: boolean;
}

export interface UsePerformanceMonitorReturn {
  metrics: PerformanceMetrics;
  warning: string | null;
  error: string | null;
}

/**
 * Monitor FPS and dataset size, provide warnings/errors
 */
export function usePerformanceMonitor(
  options: UsePerformanceMonitorOptions = {}
): UsePerformanceMonitorReturn {
  const {
    datasetSize = 0,
    fpsThreshold = 60,
    datasetThreshold = 50000,
    enabled = true,
  } = options;

  const [metrics, setMetrics] = useState<PerformanceMetrics>({
    fps: 60,
    frameTime: 16.67,
    avgFrameTime: 16.67,
    datasetSize,
    isLowFPS: false,
    isLargeDataset: false,
  });

  useEffect(() => {
    if (!enabled) return;

    const frameTimes: number[] = [];
    let lastTime = performance.now();
    let frameCount = 0;
    let animationFrame = 0;

    const measurePerformance = () => {
      const now = performance.now();
      const delta = now - lastTime;
      lastTime = now;

      frameTimes.push(delta);
      if (frameTimes.length > 60) {
        frameTimes.shift();
      }

      frameCount++;

      // Update stats every 10 frames for stability
      if (frameCount % 10 === 0) {
        const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
        const fps = 1000 / avgFrameTime;

        const isLowFPS = fps < fpsThreshold;
        const isLargeDataset = datasetSize > datasetThreshold;

        setMetrics({
          fps: Math.round(fps),
          frameTime: Math.round(delta * 100) / 100,
          avgFrameTime: Math.round(avgFrameTime * 100) / 100,
          datasetSize,
          isLowFPS,
          isLargeDataset,
        });
      }

      animationFrame = requestAnimationFrame(measurePerformance);
    };

    animationFrame = requestAnimationFrame(measurePerformance);
    return () => cancelAnimationFrame(animationFrame);
  }, [enabled, fpsThreshold, datasetThreshold, datasetSize]);

  // Generate warnings and errors
  const warning = useMemo(() => {
    if (metrics.isLargeDataset && metrics.fps < 60 && metrics.fps >= 30) {
      return `Large dataset (${metrics.datasetSize.toLocaleString()} points) may impact performance. Current FPS: ${metrics.fps}`;
    }
    if (metrics.isLargeDataset) {
      return `Large dataset detected: ${metrics.datasetSize.toLocaleString()} points. Consider filtering data.`;
    }
    if (metrics.isLowFPS && metrics.fps >= 30) {
      return `Frame rate below 60fps (${metrics.fps} FPS). Performance may be degraded.`;
    }
    return null;
  }, [metrics]);

  const error = useMemo(() => {
    if (metrics.isLowFPS && metrics.fps < 30) {
      return `Critical performance issue: Frame rate is ${metrics.fps} FPS (below 30 FPS). Dataset size: ${metrics.datasetSize.toLocaleString()} points. Please reduce dataset size or apply filters.`;
    }
    if (metrics.isLargeDataset && metrics.datasetSize > datasetThreshold * 2) {
      return `Dataset too large: ${metrics.datasetSize.toLocaleString()} points exceeds recommended limit of ${datasetThreshold.toLocaleString()}. Please apply filters to reduce data size.`;
    }
    return null;
  }, [metrics, datasetThreshold]);

  return { metrics, warning, error };
}

