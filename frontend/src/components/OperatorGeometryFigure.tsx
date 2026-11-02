import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { describeGeometry, type OperatorGeometry } from "@/lib/operator-geometry";
import { EDGES, VERTEX_LABELS, VERTICES, project, randomRotation, type Rotation } from "@/lib/tesseract";

const BONE = "243, 240, 232"; // --warm-white
const SPEED = { xy: 0.004, zw: 0.003, xz: 0.0015 }; // radians per frame, as the pattern lock
const REVEAL_MS = 700;

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The operator's rotating tesseract (GAU-235): faint until a passkey is known,
 * then the operator's marked vertices, accent edges and colour fade in. Each
 * mount starts at a new orientation. A recognition cue, not a security control
 * (see lib/operator-geometry.ts). `mark` is the small header version.
 */
export function OperatorGeometryFigure({
  geometry,
  size = 160,
  variant = "full",
  className,
}: {
  geometry: OperatorGeometry | null;
  size?: number;
  variant?: "full" | "mark";
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rotation = useRef<Rotation | null>(null);
  const revealFrom = useRef<number | null>(null);
  const still = usePrefersReducedMotion();

  useEffect(() => {
    revealFrom.current = geometry ? performance.now() : null;
  }, [geometry]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const unit = size / 160;
    const accentEdges = new Set(geometry?.accents ?? []);
    let frame = 0;
    // A new starting orientation for each mounted figure, kept across geometry updates.
    rotation.current ??= randomRotation();
    const rot = rotation.current;

    const draw = (now: number) => {
      if (!still) {
        rot.xy += SPEED.xy * (geometry?.spin.xy ?? 1);
        rot.zw += SPEED.zw * (geometry?.spin.zw ?? 1);
        rot.xz += SPEED.xz * (geometry?.spin.xz ?? 1);
      }
      const reveal = geometry ? (still || revealFrom.current === null ? 1 : Math.min(1, (now - revealFrom.current) / REVEAL_MS)) : 0;
      const points = VERTICES.map((v) => project(v, rot, size));

      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(0.75, unit);
      ctx.strokeStyle = `rgba(${BONE}, ${variant === "mark" ? 0.32 : 0.15})`;
      ctx.beginPath();
      EDGES.forEach(([i, j], e) => {
        if (accentEdges.has(e) && reveal > 0) return;
        ctx.moveTo(points[i].x, points[i].y);
        ctx.lineTo(points[j].x, points[j].y);
      });
      ctx.stroke();

      if (geometry && reveal > 0) {
        ctx.strokeStyle = rgba(geometry.colour, 0.55 * reveal);
        ctx.lineWidth = Math.max(1, 1.25 * unit);
        ctx.beginPath();
        for (const e of geometry.accents) {
          const [i, j] = EDGES[e];
          ctx.moveTo(points[i].x, points[i].y);
          ctx.lineTo(points[j].x, points[j].y);
        }
        ctx.stroke();

        ctx.strokeStyle = rgba(geometry.colour, 0.9 * reveal);
        ctx.lineWidth = Math.max(1.25, 2 * unit);
        ctx.beginPath();
        geometry.marked.forEach((v, n) => (n ? ctx.lineTo(points[v].x, points[v].y) : ctx.moveTo(points[v].x, points[v].y)));
        ctx.stroke();
      }

      const marked = new Set(geometry?.marked ?? []);
      points.forEach((p, v) => {
        const on = marked.has(v) && reveal > 0;
        if (variant === "mark" && !on) return;
        ctx.beginPath();
        ctx.arc(p.x, p.y, on ? Math.max(1.5, 4 * unit) : Math.max(1, 2 * unit), 0, Math.PI * 2);
        ctx.fillStyle = on && geometry ? rgba(geometry.colour, reveal) : `rgba(${BONE}, 0.55)`;
        ctx.fill();
      });

      if (variant === "full" && geometry && reveal > 0) {
        ctx.font = `600 ${Math.round(11 * unit)}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.fillStyle = rgba(geometry.colour, reveal);
        for (const v of geometry.marked) ctx.fillText(VERTEX_LABELS[v], points[v].x, points[v].y - 9 * unit);
      }

      if (!still || reveal < 1) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [geometry, size, still, variant]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={describeGeometry(geometry)}
      title={geometry ? `${geometry.colourName} · ${geometry.code}` : undefined}
      style={{ width: size, height: size }}
      className={className}
    />
  );
}
