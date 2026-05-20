/**
 * SentryCanvas — Alert-First Polymorphic Geometric Sentry
 *
 * Starts in ALERT (red shards). Transitions to NOMINAL (gold polyhedron)
 * only after operator device fingerprint is verified from localStorage.
 *
 * States:
 *   ALERT    → unknown device / snooper detected (red, fractured)
 *   LEARNING → building fingerprint (cyan, morphing)
 *   WATCH    → possible environmental threat (amber, cracking)
 *   NOMINAL  → known operator device (gold, elegant rotation)
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { buildFingerprint, verifyFingerprint, learnDevice } from "@/lib/operator-fingerprint";

export type SentryState = "ALERT" | "LEARNING" | "WATCH" | "NOMINAL";

const STATE_COLORS: Record<SentryState, { primary: string; secondary: string; glow: string }> = {
  ALERT:    { primary: "#ef4444", secondary: "#dc2626", glow: "rgba(239,68,68,0.4)"    },
  LEARNING: { primary: "#22d3ee", secondary: "#0891b2", glow: "rgba(34,211,238,0.35)"  },
  WATCH:    { primary: "#f59e0b", secondary: "#d97706", glow: "rgba(245,158,11,0.35)"  },
  NOMINAL:  { primary: "#eab308", secondary: "#ca8a04", glow: "rgba(234,179,8,0.3)"    },
};

/* A minimal icosahedron vertex set for the morphing polyhedron */
const PHI = (1 + Math.sqrt(5)) / 2;
const BASE_VERTS: [number, number, number][] = [
  [-1,  PHI, 0], [1,  PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1,  PHI], [0,  1,  PHI], [0, -1, -PHI], [0,  1, -PHI],
  [PHI, 0, -1], [PHI, 0,  1], [-PHI, 0, -1], [-PHI, 0,  1],
];

const EDGES: [number, number][] = [
  [0,1],[0,5],[0,7],[0,10],[0,11],
  [1,5],[1,7],[1,8],[1,9],
  [2,3],[2,4],[2,6],[2,10],[2,11],
  [3,4],[3,6],[3,8],[3,9],
  [4,5],[4,9],[4,11],
  [5,9],[5,11],
  [6,7],[6,8],[6,10],
  [7,8],[7,10],
  [8,9],[10,11],
];

function rotateY(v: [number, number, number], a: number): [number, number, number] {
  return [v[0]*Math.cos(a)+v[2]*Math.sin(a), v[1], -v[0]*Math.sin(a)+v[2]*Math.cos(a)];
}
function rotateX(v: [number, number, number], a: number): [number, number, number] {
  return [v[0], v[1]*Math.cos(a)-v[2]*Math.sin(a), v[1]*Math.sin(a)+v[2]*Math.cos(a)];
}

interface SentryCanvasProps {
  onNominal?: () => void;
  className?: string;
}

export function SentryCanvas({ onNominal, className = "" }: SentryCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<SentryState>("ALERT");
  const [displayState, setDisplayState] = useState<SentryState>("ALERT");
  const frameRef = useRef<number>(0);
  const tRef = useRef(0);
  const shardPhase = useRef(0);

  const transitionTo = useCallback((next: SentryState) => {
    stateRef.current = next;
    setDisplayState(next);
    if (next === "NOMINAL" && onNominal) onNominal();
  }, [onNominal]);

  /* ── Device fingerprint check ──────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      transitionTo("LEARNING");
      const fp = await buildFingerprint();
      if (cancelled) return;

      const known = verifyFingerprint(fp);
      if (known) {
        setTimeout(() => !cancelled && transitionTo("NOMINAL"), 2500);
      } else {
        // Store fingerprint on first use — operator will need to auth below
        learnDevice(fp);
        setTimeout(() => !cancelled && transitionTo("ALERT"), 1200);
      }
    })();
    return () => { cancelled = true; };
  }, [transitionTo]);

  /* ── Live snooper detection ────────────────────────────────────────────── */
  useEffect(() => {
    let prevDeviceCount = 0;

    const checkDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter(d => d.kind === "videoinput").length;
        if (prevDeviceCount > 0 && videoInputs > prevDeviceCount) {
          // New camera appeared mid-session
          transitionTo("ALERT");
        } else if (videoInputs > 0 && stateRef.current === "NOMINAL") {
          transitionTo("WATCH");
        }
        prevDeviceCount = videoInputs;
      } catch { /* permisison denied — safe */ }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden" && stateRef.current === "NOMINAL") {
        transitionTo("WATCH");
      }
    };

    navigator.mediaDevices.addEventListener?.("devicechange", checkDevices);
    document.addEventListener("visibilitychange", handleVisibility);
    checkDevices();

    return () => {
      navigator.mediaDevices.removeEventListener?.("devicechange", checkDevices);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [transitionTo]);

  /* ── Canvas animation loop ─────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const CX = W / 2;
    const CY = H / 2;
    const SCALE = Math.min(W, H) * 0.32;

    const draw = () => {
      tRef.current += 0.012;
      const t = tRef.current;
      const state = stateRef.current;
      const col = STATE_COLORS[state];

      ctx.clearRect(0, 0, W, H);

      // Glow background
      const grad = ctx.createRadialGradient(CX, CY, 0, CX, CY, SCALE * 1.4);
      grad.addColorStop(0, col.glow);
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      // Morph factor: ALERT=high chaos, NOMINAL=smooth
      const chaos = state === "ALERT" ? 0.35 : state === "WATCH" ? 0.15 : state === "LEARNING" ? 0.08 : 0.02;
      const speed = state === "ALERT" ? 3.5 : state === "WATCH" ? 1.5 : state === "LEARNING" ? 1.2 : 0.6;

      // Build morphing verts
      const verts = BASE_VERTS.map((v, i): [number, number, number] => [
        v[0] + Math.sin(t * speed + i * 1.3) * chaos,
        v[1] + Math.cos(t * speed * 0.7 + i * 0.9) * chaos,
        v[2] + Math.sin(t * speed * 1.1 + i * 1.7) * chaos,
      ]);

      // Rotation
      const rotY = t * 0.4 * (state === "ALERT" ? 2.5 : 1);
      const rotX = t * 0.22;
      const projected = verts.map(v => {
        const r = rotateX(rotateY(v, rotY), rotX);
        // Perspective projection
        const z = r[2] + 4;
        const px = CX + (r[0] / z) * SCALE;
        const py = CY + (r[1] / z) * SCALE;
        return { px, py, z };
      });

      // ALERT shard fragmentation effect
      if (state === "ALERT" || state === "WATCH") {
        shardPhase.current += 0.04;
        for (let s = 0; s < 6; s++) {
          const sAngle = shardPhase.current + s * (Math.PI * 2 / 6);
          const sDist = SCALE * (0.8 + Math.sin(shardPhase.current * 2 + s) * 0.3);
          ctx.beginPath();
          ctx.moveTo(CX, CY);
          ctx.lineTo(CX + Math.cos(sAngle) * sDist, CY + Math.sin(sAngle) * sDist * 0.6);
          ctx.lineTo(CX + Math.cos(sAngle + 0.4) * sDist * 0.4, CY + Math.sin(sAngle + 0.4) * sDist * 0.3);
          ctx.closePath();
          ctx.fillStyle = col.primary + "18";
          ctx.fill();
          ctx.strokeStyle = col.primary + "60";
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }

      // Draw edges
      ctx.lineWidth = state === "NOMINAL" ? 1.2 : 0.8;
      for (const [a, b] of EDGES) {
        const va = projected[a];
        const vb = projected[b];
        const avgZ = (va.z + vb.z) / 2;
        const alpha = Math.max(0.05, Math.min(0.9, (avgZ - 1) / 5));
        ctx.beginPath();
        ctx.moveTo(va.px, va.py);
        ctx.lineTo(vb.px, vb.py);
        ctx.strokeStyle = col.primary + Math.round(alpha * 255).toString(16).padStart(2, "0");
        ctx.stroke();
      }

      // Draw vertices
      for (const v of projected) {
        ctx.beginPath();
        ctx.arc(v.px, v.py, state === "NOMINAL" ? 2 : 1.5, 0, Math.PI * 2);
        ctx.fillStyle = col.secondary;
        ctx.fill();
      }

      // State label
      ctx.font = "bold 9px monospace";
      ctx.fillStyle = col.primary;
      ctx.textAlign = "center";
      ctx.fillText(`SENTRY_${state}`, CX, H - 8);

      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  return (
    <canvas
      id="sentry-canvas"
      ref={canvasRef}
      width={180}
      height={180}
      className={`block ${className}`}
      aria-label={`sentry-state-${displayState.toLowerCase()}`}
      title={`Sentry: ${displayState}`}
    />
  );
}
