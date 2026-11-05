import { useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams, type Location } from "react-router-dom";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { Check, Fingerprint, Smartphone } from "lucide-react";
import { OperatorGeometryFigure } from "@/components/OperatorGeometryFigure";
import { PatternPad, type PadFeedback } from "@/components/PatternPad";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { refreshOperatorGeometry, useOperatorGeometry } from "@/hooks/useOperatorGeometry";
import { refreshOperatorPattern, useOperatorPattern } from "@/hooks/useOperatorPattern";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { addPasskey, passkeyTouch, useSession } from "@/lib/auth-client";
import { samePattern, setPatternRequest } from "@/lib/pattern";
import { landingFor, roleOf } from "@/lib/roles";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { fetchWithStepUp, StepUpCancelled } from "@/lib/step-up";

type Step = "intro" | "passkey" | "geometry" | "draw" | "confirm" | "done";

const STAGES: Array<{ id: string; label: string; steps: Step[] }> = [
  { id: "key", label: "Passkey", steps: ["intro", "passkey"] },
  { id: "figure", label: "Geometry", steps: ["geometry"] },
  { id: "pattern", label: "Pattern", steps: ["draw", "confirm"] },
  { id: "done", label: "Ready", steps: ["done"] },
];

const list: Variants = { hidden: {}, shown: { transition: { staggerChildren: 0.12, delayChildren: 0.15 } } };
const item: Variants = { hidden: { opacity: 0, y: 10 }, shown: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 24 } } };

function afterSetup(location: Location, user: unknown): string {
  const from = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from;
  return from?.pathname ? safeRedirectPath(`${from.pathname}${from.search ?? ""}`, landingFor(roleOf(user))) : landingFor(roleOf(user));
}

function Stage({ step }: { step: Step }) {
  const at = STAGES.findIndex((s) => s.steps.includes(step));
  return (
    <ol className="flex items-center justify-center gap-2" aria-label="Setup progress">
      {STAGES.map((s, i) => (
        <li key={s.id} className="relative flex items-center gap-2">
          <span className={`relative z-10 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] ${i <= at ? "text-foreground" : "text-muted-foreground"}`}>
            {i < at ? <Check className="mr-1 inline h-3 w-3" aria-hidden="true" /> : null}
            {s.label}
          </span>
          {i === at && <motion.span layoutId="setup-stage" className="absolute inset-0 rounded-full border border-charcoal bg-panel" aria-hidden="true" />}
          {i < STAGES.length - 1 && <span className="h-px w-4 bg-charcoal" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

function Panel({ children, stepKey }: { children: ReactNode; stepKey: string }) {
  const still = usePrefersReducedMotion();
  return (
    <motion.section
      key={stepKey}
      initial={still ? false : { opacity: 0, x: 36 }}
      animate={{ opacity: 1, x: 0 }}
      exit={still ? undefined : { opacity: 0, x: -36 }}
      transition={{ type: "spring", stiffness: 240, damping: 28 }}
      className="flex flex-col items-center text-center"
    >
      {children}
    </motion.section>
  );
}

/**
 * Operator setup (GAU-235), after the first email sign-in: a passkey, the operator's geometry,
 * then their pattern, drawn twice. /setup?change=1 changes the pattern (it needs the current
 * one drawn in this session and a fresh passkey touch).
 */
export default function OperatorSetup() {
  useDocumentTitle("Set up sign-in");
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const changing = params.get("change") === "1";
  const { data } = useSession();
  const userId = data?.user?.id ?? null;
  const { passkeys, geometry } = useOperatorGeometry();
  const { status } = useOperatorPattern(userId);
  const still = usePrefersReducedMotion();
  const [step, setStep] = useState<Step>(changing ? "draw" : "intro");
  const [first, setFirst] = useState<number[] | null>(null);
  const [feedback, setFeedback] = useState<PadFeedback>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<"device" | "phone" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const hasPasskey = Boolean(passkeys && passkeys.length > 0);
  const colour = geometry?.colour;

  const add = async (where: "device" | "phone") => {
    setBusy(where);
    setMessage(null);
    const error = await addPasskey(where);
    setBusy(null);
    if (error) return setMessage(error);
    refreshOperatorGeometry();
    setStep("geometry");
  };

  // The touch comes first: setting the pattern needs a passkey touch in the last 5 minutes,
  // and asking for it after two drawings would throw both away if the prompt were closed.
  const [touching, setTouching] = useState(false);
  const startDrawing = async () => {
    setMessage(null);
    const touchedAt = Date.parse(String((data?.session as { passkeyAt?: unknown } | undefined)?.passkeyAt ?? ""));
    if (Number.isFinite(touchedAt) && Date.now() - touchedAt < 4 * 60_000) {
      setStep("draw");
      return;
    }
    setTouching(true);
    const touch = await passkeyTouch("confirm");
    setTouching(false);
    if ("error" in touch) {
      setMessage(touch.error);
      return;
    }
    setStep("draw");
  };

  const restartDrawing = (note: string) => {
    setFeedback({ kind: "miss", message: note });
    window.setTimeout(() => {
      setFirst(null);
      setFeedback({ kind: "idle" });
      setAttempt((n) => n + 1);
      setStep("draw");
    }, 1100);
  };

  const confirm = async (pattern: number[]) => {
    if (!first || !samePattern(first, pattern)) return restartDrawing("That's not the same pattern. Draw a new one from the start.");
    setFeedback({ kind: "checking" });
    const [url, init] = setPatternRequest(pattern);
    try {
      const res = await fetchWithStepUp(url, init, async () => {
        const touch = await passkeyTouch("confirm");
        if ("error" in touch) {
          setMessage(touch.error);
          return false;
        }
        return touch.userId === userId;
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (res.status === 428 && body.code === "PATTERN_REQUIRED") {
        navigate("/pattern", { state: { from: { pathname: "/setup", search: "?change=1" } } });
        return;
      }
      if (!res.ok) return restartDrawing(body.error ?? `Could not set the pattern (HTTP ${res.status}).`);
      setFeedback({ kind: "ok" });
      refreshOperatorPattern();
      window.setTimeout(() => setStep("done"), still ? 0 : 900);
    } catch (err) {
      setFeedback({ kind: "idle" });
      if (!(err instanceof StepUpCancelled)) setMessage(err instanceof Error ? err.message : "Could not set the pattern.");
      setAttempt((n) => n + 1);
    }
  };

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="hud-panel w-full max-w-md overflow-hidden p-6 sm:p-8">
        <p className="brand-label">00_SETUP · GAUSS AURORA</p>
        <div className="mt-4">
          <Stage step={step} />
        </div>

        <div className="mt-6 min-h-[420px]">
          <AnimatePresence mode="wait" initial={false}>
            {step === "intro" && (
              <Panel stepKey="intro">
                <h1 className="text-2xl font-semibold leading-tight">Set up your operator sign-in.</h1>
                <p className="mt-2 text-sm text-muted-foreground">Three things, about a minute. Then signing in is a touch and a pattern.</p>
                <motion.ol variants={list} initial={still ? "shown" : "hidden"} animate="shown" className="mt-6 w-full space-y-3 text-left">
                  {[
                    ["Passkey", "Touch ID on this Mac, or Face ID on your phone. Your fingerprint or face never leaves the device."],
                    ["Your geometry", "A tesseract that's yours alone, so you can tell your session at a glance. A cue, not a lock."],
                    ["Your pattern", "A path you draw through the tesseract's lettered vertices: the second check, after the touch."],
                  ].map(([title, text], i) => (
                    <motion.li key={title} variants={item} className="flex gap-3 rounded-md border border-charcoal bg-panel px-4 py-3">
                      <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
                      <span>
                        <span className="block text-sm font-medium">{title}</span>
                        <span className="block text-xs text-muted-foreground">{text}</span>
                      </span>
                    </motion.li>
                  ))}
                </motion.ol>
                <Button className="mt-6" onClick={() => setStep(hasPasskey ? "geometry" : "passkey")}>
                  Begin
                </Button>
              </Panel>
            )}

            {step === "passkey" && (
              <Panel stepKey="passkey">
                <h2 className="text-xl font-semibold">Add your passkey</h2>
                <p className="mt-2 text-sm text-muted-foreground">Choose where it lives. You can add the other one later from your account page.</p>
                <div className="mt-6 grid w-full gap-3">
                  <motion.button
                    whileHover={still ? undefined : { y: -2 }}
                    whileTap={still ? undefined : { scale: 0.98 }}
                    disabled={busy !== null}
                    onClick={() => void add("device")}
                    className="flex items-center gap-3 rounded-md border border-charcoal bg-panel px-4 py-3 text-left transition-colors hover:bg-secondary disabled:opacity-60"
                  >
                    <Fingerprint className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span>
                      <span className="block text-sm font-medium">{busy === "device" ? "Touch the sensor…" : "This computer"}</span>
                      <span className="block text-xs text-muted-foreground">Touch ID. In Chrome this needs iCloud Keychain or Google Password Manager passkeys on; Safari works as is.</span>
                    </span>
                  </motion.button>
                  <motion.button
                    whileHover={still ? undefined : { y: -2 }}
                    whileTap={still ? undefined : { scale: 0.98 }}
                    disabled={busy !== null}
                    onClick={() => void add("phone")}
                    className="flex items-center gap-3 rounded-md border border-charcoal bg-panel px-4 py-3 text-left transition-colors hover:bg-secondary disabled:opacity-60"
                  >
                    <Smartphone className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span>
                      <span className="block text-sm font-medium">{busy === "phone" ? "Scan the code with your phone…" : "My phone"}</span>
                      <span className="block text-xs text-muted-foreground">The browser shows a QR code: scan it with the phone's camera and use Face ID. Keep Bluetooth on and the phone near.</span>
                    </span>
                  </motion.button>
                </div>
                {message && (
                  <p role="alert" className="mt-4 rounded-md border border-caution/50 bg-caution/10 px-3 py-2 text-left text-sm text-caution">
                    {message}
                  </p>
                )}
              </Panel>
            )}

            {step === "geometry" && (
              <Panel stepKey="geometry">
                <h2 className="text-xl font-semibold">This is yours.</h2>
                <motion.div
                  initial={still ? false : { opacity: 0, scale: 0.7, rotate: -12 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 120, damping: 16, delay: 0.1 }}
                  className="my-4"
                >
                  <OperatorGeometryFigure geometry={geometry} size={220} />
                </motion.div>
                {geometry ? (
                  <p className="font-mono text-lg tracking-[0.3em]" aria-label={`Your code: ${geometry.code}`}>
                    {geometry.code.split("·").map((letter, i) => (
                      <motion.span
                        key={`${letter}-${i}`}
                        initial={still ? false : { opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.7 + i * 0.14 }}
                        style={{ color: colour }}
                        className="inline-block"
                      >
                        {letter}
                        {i < 3 ? <span className="text-muted-foreground">·</span> : null}
                      </motion.span>
                    ))}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">Reading your passkey…</p>
                )}
                <p className="mt-3 max-w-sm text-sm text-muted-foreground">
                  {geometry ? `${geometry.colourName}, ` : ""}from your passkey. You'll see it when you sign in and in the console header. It helps you spot
                  your own session; it doesn't lock anything.
                </p>
                <Button className="mt-6" disabled={!geometry || touching} onClick={() => void startDrawing()}>
                  <Fingerprint className="h-4 w-4" aria-hidden="true" />
                  {touching ? "Touch the sensor…" : "Touch, then draw your pattern"}
                </Button>
                {message && (
                  <p role="alert" className="mt-3 max-w-sm text-sm text-caution">
                    {message}
                  </p>
                )}
              </Panel>
            )}

            {(step === "draw" || step === "confirm") && (
              <Panel stepKey={`${step}-${attempt}`}>
                <h2 className="text-xl font-semibold">{step === "draw" ? (changing ? "Draw a new pattern" : "Draw your pattern") : "Once more, to be sure"}</h2>
                <p className="mb-4 mt-2 max-w-sm text-sm text-muted-foreground">
                  {step === "draw"
                    ? "Tap or swipe through 8 or more vertices, at least 6 different ones. The figure turns, so remember the letters, not the shape."
                    : "Draw the same pattern again."}
                </p>
                <PatternPad
                  key={`${step}-${attempt}`}
                  colour={colour}
                  submitLabel={step === "draw" ? "Next" : "Set pattern"}
                  feedback={step === "confirm" ? feedback : { kind: "idle" }}
                  onSubmit={(pattern) => {
                    if (step === "draw") {
                      setFirst(pattern);
                      setStep("confirm");
                    } else void confirm(pattern);
                  }}
                />
                {message && (
                  <p role="alert" className="mt-3 text-sm text-caution">
                    {message}
                  </p>
                )}
              </Panel>
            )}

            {step === "done" && (
              <Panel stepKey="done">
                <motion.svg viewBox="0 0 52 52" className="h-14 w-14" aria-hidden="true">
                  <motion.circle
                    cx="26"
                    cy="26"
                    r="24"
                    fill="none"
                    stroke={colour ?? "currentColor"}
                    strokeWidth="2"
                    initial={still ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.6 }}
                  />
                  <motion.path
                    d="M15 27 l7 7 l15 -16"
                    fill="none"
                    stroke={colour ?? "currentColor"}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={still ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.45, delay: 0.5 }}
                  />
                </motion.svg>
                <h2 className="mt-4 text-xl font-semibold">{changing ? "New pattern set." : "You're set up."}</h2>
                <div className="my-4">
                  <OperatorGeometryFigure geometry={geometry} size={120} />
                </div>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Next time: touch, then draw. {status?.padOrigin ? "You can draw on your phone too." : ""} Five misses lock the pattern for 15 minutes; an
                  admin can clear a forgotten one.
                </p>
                <Button className="mt-6" onClick={() => navigate(afterSetup(location, data?.user), { replace: true })}>
                  Enter the console
                </Button>
              </Panel>
            )}
          </AnimatePresence>
        </div>
      </div>
    </main>
  );
}
