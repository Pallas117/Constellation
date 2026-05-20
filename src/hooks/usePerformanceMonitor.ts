/**
 * Hook to monitor FPS and dataset size for performance warnings
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

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

  const frameTimesRef = useRef<number[]>([]);
  const lastTimeRef = useRef(performance.now());
  const frameCountRef = useRef(0);
  const animationFrameRef = useRef<number>();

  const measurePerformance = useCallback(() => {
    const now = performance.now();
    const delta = now - lastTimeRef.current;
    lastTimeRef.current = now;

    frameTimesRef.current.push(delta);
    if (frameTimesRef.current.length > 60) {
      frameTimesRef.current.shift();
    }

    frameCountRef.current++;

    // Update stats every 10 frames for stability
    if (frameCountRef.current % 10 === 0) {
      const avgFrameTime = frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length;
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

    if (enabled) {
      animationFrameRef.current = requestAnimationFrame(measurePerformance);
    }
  }, [enabled, fpsThreshold, datasetThreshold, datasetSize]);

  useEffect(() => {
    if (enabled) {
      animationFrameRef.current = requestAnimationFrame(measurePerformance);
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [enabled, measurePerformance]);

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

