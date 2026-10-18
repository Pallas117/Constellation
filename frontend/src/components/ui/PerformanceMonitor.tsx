import { useEffect, useState, useRef, useCallback } from 'react';

interface PerformanceStats {
  fps: number;
  frameTime: number;
  avgFrameTime: number;
}

interface PerformanceMonitorProps {
  visible?: boolean;
}

export const PerformanceMonitor = ({ visible = true }: PerformanceMonitorProps) => {
  const [stats, setStats] = useState<PerformanceStats>({
    fps: 60,
    frameTime: 16.67,
    avgFrameTime: 16.67,
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
      
      setStats({
        fps: Math.round(fps),
        frameTime: Math.round(delta * 100) / 100,
        avgFrameTime: Math.round(avgFrameTime * 100) / 100,
      });
    }
    
    animationFrameRef.current = requestAnimationFrame(measurePerformance);
  }, []);

  useEffect(() => {
    if (visible) {
      animationFrameRef.current = requestAnimationFrame(measurePerformance);
    }
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [visible, measurePerformance]);

  if (!visible) return null;

  // Render rate of the 3D scene; only a slow frame rate earns a colour.
  return (
    <span
      className={`font-mono text-[11px] tabular-nums ${stats.fps < 30 ? 'text-caution' : 'text-muted-foreground'}`}
      title="Scene render rate and mean frame time"
    >
      {stats.fps} fps · {stats.avgFrameTime} ms
    </span>
  );
};
