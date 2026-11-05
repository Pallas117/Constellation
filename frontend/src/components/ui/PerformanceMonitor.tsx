import { useEffect, useState } from 'react';

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
  
  useEffect(() => {
    if (!visible) return;

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

        setStats({
          fps: Math.round(fps),
          frameTime: Math.round(delta * 100) / 100,
          avgFrameTime: Math.round(avgFrameTime * 100) / 100,
        });
      }

      animationFrame = requestAnimationFrame(measurePerformance);
    };

    animationFrame = requestAnimationFrame(measurePerformance);
    return () => cancelAnimationFrame(animationFrame);
  }, [visible]);

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
