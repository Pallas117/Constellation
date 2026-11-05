import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { Delete, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { extendPattern, PATTERN_RULES, vertexAt } from "@/lib/pattern";
import { EDGES, project, randomRotation, VERTEX_LABELS, VERTICES, type Rotation } from "@/lib/tesseract";

const BOX = 400; // drawing units; the canvas scales to its container
const BONE = "243, 240, 232";
const MISS = "#E58FA8";
const SPEED = { xy: 0.0035, zw: 0.0026, xz: 0.0013 };
const REVEAL_MS = 1100;
const RIPPLE_MS = 520;

export type PadFeedback = { kind: "idle" } | { kind: "checking" } | { kind: "ok"; message?: string } | { kind: "miss"; message: string };

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const depthOf = (d: number) => Math.min(1, Math.max(0, (d - 0.12) / 0.7));

/**
 * The pattern pad (GAU-235): the operator's tesseract, turning slowly until the first touch,
 * then still while they draw. Tap vertices or swipe through them; letters A to P, Backspace and
 * Enter work too. The figure starts at a new orientation every time, so a pattern is the
 * vertices it passes through (their letters), never a shape on the screen. To clear it for a
 * new step, remount it with a new `key` (the figure then draws itself in again).
 */
export function PatternPad({
  colour = "#78C8E6",
  submitLabel = "Done",
  onSubmit,
  feedback = { kind: "idle" },
  disabled = false,
  hint,
}: {
  colour?: string;
  submitLabel?: string;
  onSubmit: (pattern: number[]) => void;
  feedback?: PadFeedback;
  disabled?: boolean;
  hint?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pattern, setPattern] = useState<number[]>([]);
  const patternRef = useRef<number[]>([]);
  const rotation = useRef<Rotation | null>(null);
  const frozen = useRef(false);
  const pointer = useRef<{ x: number; y: number; down: boolean; touch: boolean }>({ x: 0, y: 0, down: false, touch: false });
  const ripples = useRef<Array<{ v: number; at: number }>>([]);
  const points = useRef<Array<{ x: number; y: number; depth: number }>>([]);
  const feedbackRef = useRef<PadFeedback>(feedback);
  const revealFrom = useRef<number>(0);
  const missAt = useRef<number>(-Infinity);
  const still = usePrefersReducedMotion();
  const shake = useAnimationControls();
  const busy = disabled || feedback.kind === "checking" || feedback.kind === "ok";

  const commit = useCallback((next: number[]) => {
    patternRef.current = next;
    setPattern(next);
  }, []);

  useEffect(() => {
    revealFrom.current = performance.now();
  }, []);

  useEffect(() => {
    feedbackRef.current = feedback;
    if (feedback.kind === "ok") ripples.current = patternRef.current.map((v, i) => ({ v, at: performance.now() + i * 70 }));
    if (feedback.kind === "miss") {
      missAt.current = performance.now();
      if (!still) void shake.start({ x: [0, -12, 11, -7, 6, -2, 0], transition: { duration: 0.5 } });
    }
  }, [feedback, shake, still]);

  const add = useCallback(
    (vertex: number) => {
      const before = patternRef.current;
      const next = extendPattern(before, vertex);
      if (next.length === before.length) return;
      commit(next);
      ripples.current.push({ v: vertex, at: performance.now() });
      navigator.vibrate?.(8);
    },
    [commit],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = canvas.height = Math.round(BOX * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rotation.current ??= randomRotation();
    const rot = rotation.current;
    let frame = 0;

    const draw = (now: number) => {
      const fb = feedbackRef.current;
      if (!still && !frozen.current) {
        rot.xy += SPEED.xy;
        rot.zw += SPEED.zw;
        rot.xz += SPEED.xz;
      }
      const reveal = still ? 1 : Math.min(1, (now - revealFrom.current) / REVEAL_MS);
      const pts = VERTICES.map((v) => project(v, rot, BOX));
      points.current = pts;
      const path = patternRef.current;
      const missing = fb.kind === "miss" && now - missAt.current < 900;
      const ink = missing ? MISS : colour;
      ctx.clearRect(0, 0, BOX, BOX);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // The figure draws itself in, edge by edge, nearer edges brighter.
      EDGES.forEach(([i, j], e) => {
        const grow = Math.min(1, Math.max(0, reveal * 1.7 - (e / EDGES.length) * 0.7));
        if (grow <= 0) return;
        const a = pts[i];
        const b = pts[j];
        const near = (depthOf(a.depth) + depthOf(b.depth)) / 2;
        ctx.strokeStyle = `rgba(${BONE}, ${0.07 + 0.22 * near})`;
        ctx.lineWidth = 0.8 + 0.8 * near;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + (b.x - a.x) * grow, a.y + (b.y - a.y) * grow);
        ctx.stroke();
      });

      // The drawn path: a soft underlay and a flowing dashed line on top, plus the live rubber band.
      if (path.length > 0) {
        const trace = () => {
          ctx.beginPath();
          path.forEach((v, n) => (n ? ctx.lineTo(pts[v].x, pts[v].y) : ctx.moveTo(pts[v].x, pts[v].y)));
          if (pointer.current.down && fb.kind !== "ok" && fb.kind !== "checking") ctx.lineTo(pointer.current.x, pointer.current.y);
        };
        const width = fb.kind === "ok" ? 5 : 3;
        ctx.setLineDash([]);
        ctx.strokeStyle = rgba(ink, fb.kind === "ok" ? 0.55 : 0.28);
        ctx.lineWidth = width + 4;
        trace();
        ctx.stroke();
        ctx.setLineDash(still ? [] : [12, 9]);
        ctx.lineDashOffset = still ? 0 : -now / 28;
        ctx.strokeStyle = rgba(ink, 0.95);
        ctx.lineWidth = width;
        trace();
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Vertices: nearer ones larger and brighter; chosen ones in the operator's colour.
      ctx.textAlign = "center";
      const order = new Map<number, number>();
      path.forEach((v, n) => order.set(v, n));
      pts.forEach((p, v) => {
        const appear = Math.min(1, Math.max(0, reveal * 2 - 1 + (v / VERTICES.length) * 0.4));
        if (appear <= 0) return;
        const near = depthOf(p.depth);
        const on = order.has(v);
        ctx.beginPath();
        ctx.arc(p.x, p.y, (on ? 6.5 + 2.5 * near : 3 + 2.5 * near) * appear, 0, Math.PI * 2);
        ctx.fillStyle = on ? rgba(ink, 1) : `rgba(${BONE}, ${(0.35 + 0.55 * near) * appear})`;
        ctx.fill();
        ctx.font = `600 ${Math.round(11 + 3 * near)}px ui-monospace, SFMono-Regular, monospace`;
        ctx.fillStyle = on ? rgba(ink, 1) : `rgba(170, 179, 194, ${(0.45 + 0.5 * near) * appear})`;
        ctx.fillText(VERTEX_LABELS[v], p.x, p.y - 12 - 4 * near);
      });

      // Ripples where a vertex was just chosen (and along the whole path on success).
      ripples.current = ripples.current.filter((r) => now - r.at < RIPPLE_MS);
      for (const r of ripples.current) {
        const k = (now - r.at) / RIPPLE_MS;
        if (k < 0) continue;
        const p = pts[r.v];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8 + 30 * k, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(ink, 0.6 * (1 - k));
        ctx.lineWidth = 2 * (1 - k) + 0.5;
        ctx.stroke();
      }

      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [colour, still]);

  // A miss shows in rose for a moment, then the pad clears for another go.
  useEffect(() => {
    if (feedback.kind !== "miss") return;
    const t = window.setTimeout(() => {
      commit([]);
      frozen.current = false;
    }, 900);
    return () => window.clearTimeout(t);
  }, [feedback, commit]);

  const local = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * BOX) / r.width, y: ((e.clientY - r.top) * BOX) / r.height };
  };
  const hit = (x: number, y: number, touch: boolean) => add(vertexAt(points.current, x, y, touch ? 34 : 24));

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    frozen.current = true; // still while drawing: no chasing a moving vertex
    const { x, y } = local(e);
    pointer.current = { x, y, down: true, touch: e.pointerType !== "mouse" };
    hit(x, y, pointer.current.touch);
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!pointer.current.down || busy) return;
    const { x, y } = local(e);
    pointer.current.x = x;
    pointer.current.y = y;
    hit(x, y, pointer.current.touch);
  };
  const onPointerUp = () => {
    pointer.current.down = false;
  };

  const ready = pattern.length >= PATTERN_RULES.minLength;
  const submit = () => {
    if (ready && !busy) onSubmit(patternRef.current);
  };
  const undo = () => {
    if (busy) return;
    commit(patternRef.current.slice(0, -1));
  };
  const clear = () => {
    if (busy) return;
    commit([]);
    frozen.current = false;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (busy) return;
    if (e.key === "Backspace" || e.key === "Enter") {
      e.preventDefault();
      if (e.key === "Backspace") undo();
      else submit();
      return;
    }
    const v = VERTEX_LABELS.indexOf(e.key.toUpperCase());
    if (e.key.length === 1 && v >= 0) {
      frozen.current = true;
      add(v);
    }
  };

  const message = feedback.kind === "miss" || (feedback.kind === "ok" && feedback.message) ? feedback.message : hint;

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <motion.div animate={shake} className="relative w-full max-w-[min(360px,82vw)]">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="application"
          aria-label="Your tesseract. Tap or swipe through vertices to draw your pattern, or type their letters A to P; Backspace removes one, Enter finishes."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          className="aspect-square w-full touch-none select-none rounded-full outline-none focus-visible:ring-1 focus-visible:ring-muted-foreground/25"
        />
      </motion.div>

      <div className="flex h-6 items-center gap-1 font-mono text-xs text-muted-foreground" aria-live="polite">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={pattern.length}
            initial={still ? false : { y: -8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={still ? undefined : { y: 8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
            className="tabular-nums text-foreground"
          >
            {pattern.length}
          </motion.span>
        </AnimatePresence>
        <span>
          {pattern.length < PATTERN_RULES.minLength ? `of ${PATTERN_RULES.minLength}+ vertices` : "vertices"} ·{" "}
          {pattern.map((v) => VERTEX_LABELS[v]).join("") || "—"}
        </span>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {message && (
          <motion.p
            key={message}
            initial={still ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={still ? undefined : { opacity: 0, y: -4 }}
            className={`max-w-sm text-center text-sm ${feedback.kind === "miss" ? "text-destructive" : "text-muted-foreground"}`}
            role={feedback.kind === "miss" ? "alert" : undefined}
          >
            {message}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={undo} disabled={busy || pattern.length === 0} aria-label="Remove the last vertex">
          <Delete className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={busy || pattern.length === 0}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Clear
        </Button>
        <motion.div animate={ready && !busy && !still ? { scale: [1, 1.04, 1] } : { scale: 1 }} transition={{ duration: 0.35 }}>
          <Button type="button" size="sm" onClick={submit} disabled={!ready || busy}>
            {feedback.kind === "checking" ? "Checking…" : submitLabel}
          </Button>
        </motion.div>
      </div>
    </div>
  );
}
