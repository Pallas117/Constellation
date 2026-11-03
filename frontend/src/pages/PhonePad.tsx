import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { OperatorGeometryFigure } from "@/components/OperatorGeometryFigure";
import { PatternPad, type PadFeedback } from "@/components/PatternPad";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useNow } from "@/hooks/useNow";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { geometryForPublicKey, type OperatorGeometry } from "@/lib/operator-geometry";
import { padDraw, padInfo, type PadState } from "@/lib/pattern";

type View = { kind: "loading" } | { kind: "draw"; expiresAt: number } | { kind: "done" } | { kind: "over"; text: string };

const OVER: Record<Exclude<PadState, "waiting" | "approved">, string> = {
  expired: "This code has expired. Show a new one on the computer and scan it again.",
  failed: "Too many misses for this code. Show a new one on the computer to try again.",
};

/**
 * The phone's pattern pad (GAU-235), opened from the QR code on the computer. Public: the phone
 * has no session, only the one-time request id in the URL fragment, which the browser never
 * sends to a server and this page removes from the address bar and history at once.
 */
export default function PhonePad() {
  useDocumentTitle("Draw your pattern");
  const still = usePrefersReducedMotion();
  const [request] = useState(() => (typeof window === "undefined" ? "" : window.location.hash.replace(/^#/, "")));
  const [view, setView] = useState<View>(request ? { kind: "loading" } : { kind: "over", text: "Open this page by scanning the code on the computer." });
  const [geometry, setGeometry] = useState<OperatorGeometry | null>(null);
  const [feedback, setFeedback] = useState<PadFeedback>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const now = useNow(1000);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (!request) return;
    let live = true;
    padInfo(request)
      .then(async (info) => {
        if (!live) return;
        if (info.state !== "waiting") return setView({ kind: "over", text: info.state === "approved" ? "Already done." : OVER[info.state] });
        setView({ kind: "draw", expiresAt: info.expiresAt ?? 0 });
        if (info.geometryKey) {
          const g = await geometryForPublicKey(info.geometryKey).catch(() => null);
          if (live) setGeometry(g);
        }
      })
      .catch(() => live && setView({ kind: "over", text: "Can't reach Gauss from this phone. Is it on the tailnet?" }));
    return () => {
      live = false;
    };
  }, [request]);

  const draw = async (pattern: number[]) => {
    setFeedback({ kind: "checking" });
    try {
      const result = await padDraw(request, pattern);
      if (result.ok) {
        setFeedback({ kind: "ok" });
        navigator.vibrate?.([18, 50, 18]);
        window.setTimeout(() => setView({ kind: "done" }), still ? 0 : 700);
        return;
      }
      if (result.state && result.state !== "waiting" && result.state !== "approved") {
        setView({ kind: "over", text: result.message ?? OVER[result.state] });
        return;
      }
      setFeedback({ kind: "miss", message: result.message ?? "That's not your pattern." });
      window.setTimeout(() => {
        setFeedback({ kind: "idle" });
        setAttempt((n) => n + 1);
      }, 1100);
    } catch (err) {
      setFeedback({ kind: "miss", message: err instanceof Error ? err.message : "Could not check the pattern." });
    }
  };

  const secondsLeft = view.kind === "draw" ? Math.max(0, Math.ceil((view.expiresAt - now) / 1000)) : 0;

  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center bg-background px-4 py-8 text-foreground">
      <AnimatePresence mode="wait" initial={false}>
        {view.kind === "loading" && (
          <motion.div key="loading" exit={{ opacity: 0 }} className="flex items-center gap-2 font-mono text-sm text-muted-foreground" role="status">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" aria-hidden="true" />
            Connecting…
          </motion.div>
        )}

        {view.kind === "draw" && (
          <motion.section
            key="draw"
            initial={still ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={still ? undefined : { opacity: 0, scale: 0.96 }}
            className="flex w-full max-w-sm flex-col items-center text-center"
          >
            <p className="brand-label">GAUSS AURORA · PATTERN</p>
            <div className="mt-3 flex items-center gap-3">
              <OperatorGeometryFigure geometry={geometry} size={36} variant="mark" />
              <h1 className="text-xl font-semibold">Draw your pattern</h1>
            </div>
            <p className="mb-4 mt-1 font-mono text-xs text-muted-foreground">
              {geometry ? `${geometry.colourName} · ${geometry.code} · ` : ""}
              {secondsLeft > 0 ? `${secondsLeft} s left` : "expired"}
            </p>
            <PatternPad key={attempt} colour={geometry?.colour} submitLabel="Send" feedback={feedback} disabled={secondsLeft === 0} onSubmit={(p) => void draw(p)} />
          </motion.section>
        )}

        {view.kind === "done" && (
          <motion.section
            key="done"
            initial={still ? false : { opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 160, damping: 18 }}
            className="flex flex-col items-center gap-4 text-center"
          >
            <OperatorGeometryFigure geometry={geometry} size={180} />
            <h1 className="text-2xl font-semibold">Done.</h1>
            <p className="text-sm text-muted-foreground">Look at your computer: it carries on by itself. You can close this page.</p>
          </motion.section>
        )}

        {view.kind === "over" && (
          <motion.p key="over" initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} role="alert" className="max-w-xs text-center text-sm text-muted-foreground">
            {view.text}
          </motion.p>
        )}
      </AnimatePresence>
    </main>
  );
}
