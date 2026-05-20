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

  const fpsColor = stats.fps >= 55 ? 'text-green-400' : stats.fps >= 30 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="absolute top-6 right-32 pointer-events-auto">
      <div className="hud-panel px-3 py-2 animate-fade-in-up flex items-center gap-4">
        <div className="scanline" />
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-tighter">FPS</span>
          <span className={`text-sm font-mono font-bold ${fpsColor}`}>{stats.fps}</span>
        </div>
        <div className="h-4 w-[1px] bg-primary/20" />
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-tighter">LATENCY</span>
          <span className="text-sm font-mono font-bold text-primary">{stats.avgFrameTime} ms</span>
        </div>
      </div>
    </div>
  );
};
