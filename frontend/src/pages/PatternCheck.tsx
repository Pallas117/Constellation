import { useCallback, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate, type Location } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Fingerprint, Monitor, Smartphone } from "lucide-react";
import { OperatorGeometryFigure } from "@/components/OperatorGeometryFigure";
import { PatternPad, type PadFeedback } from "@/components/PatternPad";
import { QrCode } from "@/components/QrCode";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useNow } from "@/hooks/useNow";
import { useOperatorGeometry } from "@/hooks/useOperatorGeometry";
import { refreshOperatorPattern, useOperatorPattern } from "@/hooks/useOperatorPattern";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { passkeyTouch, signOut, useSession } from "@/lib/auth-client";
import { fetchPatternStatus, noticeText, openPadRequest, verifyPattern } from "@/lib/pattern";
import { landingFor, roleOf } from "@/lib/roles";
import { safeRedirectPath } from "@/lib/safe-redirect";

const POLL_MS = 1500;

function nextPath(location: Location, user: unknown): string {
  const from = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from;
  return from?.pathname ? safeRedirectPath(`${from.pathname}${from.search ?? ""}`, landingFor(roleOf(user))) : landingFor(roleOf(user));
}

function Countdown({ until }: { until: number }) {
  const now = useNow(250);
  const left = Math.max(0, until - now);
  const total = 120_000;
  const k = Math.min(1, left / total);
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs text-muted-foreground">
      <svg viewBox="0 0 20 20" className="h-4 w-4 -rotate-90" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${50.3 * k} 50.3`} />
      </svg>
      {Math.ceil(left / 1000)} s
    </span>
  );
}

/**
 * After signing in, operators draw their pattern (GAU-235): here, or on their phone by scanning
 * a QR code (the phone opens /pad over the tailnet). The QR code's one-time id is useless
 * without the pattern and ends after two minutes, one approval or five tries.
 */
export default function PatternCheck() {
  useDocumentTitle("Draw your pattern");
  const navigate = useNavigate();
  const location = useLocation();
  const { data } = useSession();
  const userId = data?.user?.id ?? null;
  const { geometry } = useOperatorGeometry();
  const { status } = useOperatorPattern(userId);
  const still = usePrefersReducedMotion();
  const [feedback, setFeedback] = useState<PadFeedback>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [phone, setPhone] = useState<{ url: string; expiresAt: number } | null>(null);
  const [phoneNote, setPhoneNote] = useState<string | null>(null);
  const target = nextPath(location, data?.user);
  const now = useNow(5_000);

  const succeed = useCallback(() => {
    setFeedback({ kind: "ok", message: "That's you." });
    refreshOperatorPattern();
    window.setTimeout(() => navigate(target, { replace: true }), still ? 0 : 1000);
  }, [navigate, target, still]);

  const draw = async (pattern: number[]) => {
    setFeedback({ kind: "checking" });
    try {
      const result = await verifyPattern(pattern);
      if (result.ok) return succeed();
      setFeedback({ kind: "miss", message: result.message ?? "That's not your pattern." });
      window.setTimeout(() => {
        setFeedback({ kind: "idle" });
        setAttempt((n) => n + 1);
      }, 1100);
    } catch (err) {
      setFeedback({ kind: "miss", message: err instanceof Error ? err.message : "Could not check the pattern." });
    }
  };

  // Operator sessions must be opened with a passkey: one touch here (and, within the day on this
  // passkey, that is all: the server starts the session already drawn).
  const [touching, setTouching] = useState(false);
  const [touchNote, setTouchNote] = useState<string | null>(null);
  const touch = async () => {
    setTouching(true);
    setTouchNote(null);
    const result = await passkeyTouch("sign-in");
    setTouching(false);
    if ("error" in result) {
      setTouchNote(result.error);
      return;
    }
    refreshOperatorPattern();
  };

  // Already through (a touch within the day on this passkey, or the phone): straight on.
  useEffect(() => {
    if (status?.passkeySession && status.verified && feedback.kind === "idle") navigate(target, { replace: true });
  }, [status, feedback.kind, navigate, target]);

  const startPhone = async () => {
    setPhoneNote(null);
    try {
      const r = await openPadRequest();
      setPhone({ url: r.padUrl, expiresAt: r.expiresAt });
    } catch (err) {
      setPhoneNote(err instanceof Error ? err.message : "Could not start drawing on a phone.");
    }
  };

  // While the QR code shows, ask whether the phone has drawn it (the route is open to every
  // signed-in role, so polling it can't earn a 401/403).
  useEffect(() => {
    if (!phone) return;
    let live = true;
    const t = window.setInterval(async () => {
      const s = await fetchPatternStatus().catch(() => null);
      if (!live || !s) return;
      if (s.verified || s.request?.state === "approved") {
        window.clearInterval(t);
        succeed();
      } else if (s.request && s.request.state !== "waiting") {
        window.clearInterval(t);
        setPhone(null);
        setPhoneNote(s.request.state === "failed" ? "Too many misses on the phone. Show a new code to try again." : "The code expired. Show a new one.");
      }
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [phone, succeed]);

  if (status && !status.set && status.required) return <Navigate to="/setup" state={location.state} replace />;
  const locked = status?.lockedUntil && status.lockedUntil > now ? status.lockedUntil : null;
  const notice = noticeText(status?.notice, (ms) => new Date(ms).toLocaleTimeString());

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="hud-panel w-full max-w-md p-6 sm:p-8">
        <p className="brand-label">01_PATTERN · GAUSS AURORA</p>
        <div className="mt-2 flex items-center gap-3">
          <OperatorGeometryFigure geometry={geometry} size={40} variant="mark" />
          <div>
            <h1 className="text-xl font-semibold leading-tight">{status && !status.passkeySession ? "Touch, then draw." : "Draw your pattern."}</h1>
            <p className="text-xs text-muted-foreground">{geometry ? `${geometry.colourName} · ${geometry.code}` : "Your second check, after the touch."}</p>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {notice && (
            <motion.p
              key="notice"
              role="status"
              initial={still ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={still ? undefined : { opacity: 0, height: 0 }}
              className="mt-4 overflow-hidden rounded-md border border-caution/50 bg-caution/10 px-3 py-2 text-sm text-caution"
            >
              {notice}
            </motion.p>
          )}
        </AnimatePresence>

        <div className="mt-6 min-h-[440px]">
          <AnimatePresence mode="wait" initial={false}>
            {status && !status.passkeySession ? (
              <motion.section
                key="touch"
                initial={still ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={still ? undefined : { opacity: 0, y: -8 }}
                className="flex flex-col items-center gap-4 pt-10 text-center"
              >
                <OperatorGeometryFigure geometry={geometry} size={160} />
                <p className="max-w-xs text-sm text-muted-foreground">The operator console opens with your passkey: Touch ID here, or Face ID on your phone.</p>
                <Button onClick={() => void touch()} disabled={touching}>
                  <Fingerprint className="h-4 w-4" aria-hidden="true" />
                  {touching ? "Touch the sensor…" : "Continue with your passkey"}
                </Button>
                {touchNote && (
                  <p role="alert" className="max-w-xs text-sm text-caution">
                    {touchNote}
                  </p>
                )}
              </motion.section>
            ) : locked ? (
              <motion.p key="locked" initial={{ opacity: 0 }} animate={{ opacity: 1 }} role="alert" className="rounded-md border border-caution/50 bg-caution/10 px-3 py-3 text-sm text-caution">
                Too many misses: your pattern is locked until {new Date(locked).toLocaleTimeString()}. Wait, or ask an admin to clear it.
              </motion.p>
            ) : phone ? (
              <motion.section
                key="phone"
                initial={still ? false : { opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={still ? undefined : { opacity: 0, scale: 0.96 }}
                className="flex flex-col items-center gap-4 text-center"
              >
                <QrCode value={phone.url} label="QR code: scan it with your phone's camera to draw your pattern there" />
                <p className="max-w-xs text-sm text-muted-foreground">
                  Scan with your phone's camera, then draw your pattern there. This page carries on by itself.
                </p>
                <div className="flex items-center gap-3">
                  <Countdown until={phone.expiresAt} />
                  <motion.span
                    className="h-1.5 w-1.5 rounded-full bg-signal"
                    animate={still ? undefined : { opacity: [0.2, 1, 0.2] }}
                    transition={{ duration: 1.6, repeat: Infinity }}
                    aria-hidden="true"
                  />
                  <span className="font-mono text-xs text-muted-foreground">waiting for your phone</span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setPhone(null)}>
                  <Monitor className="h-4 w-4" aria-hidden="true" />
                  Draw here instead
                </Button>
              </motion.section>
            ) : (
              <motion.section key={`pad-${attempt}`} initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={still ? undefined : { opacity: 0 }}>
                <PatternPad key={attempt} colour={geometry?.colour} submitLabel="Sign in" feedback={feedback} onSubmit={(p) => void draw(p)} />
                <div className="mt-4 flex flex-col items-center gap-2">
                  {status?.padOrigin ? (
                    <Button variant="outline" size="sm" onClick={() => void startPhone()} disabled={feedback.kind === "checking" || feedback.kind === "ok"}>
                      <Smartphone className="h-4 w-4" aria-hidden="true" />
                      Draw on my phone
                    </Button>
                  ) : null}
                  {phoneNote && <p className="text-sm text-caution">{phoneNote}</p>}
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-4 text-center">
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => void signOut().then(() => navigate("/login", { replace: true }))}
          >
            Not you? Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
