import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { openedOverStage, stageHref } from "@/lib/auth-stage";

/**
 * The frame every sign-in step draws in: a modal over the live visualisation
 * (the router keeps the page behind mounted and inert, see lib/auth-stage.ts).
 * Later steps (passkey touch, operator pattern, step-up) render as children, so
 * the whole login stays on one stage and the globe never reloads between steps.
 */
export function AuthStage({ children, label = "Sign in" }: { children: ReactNode; label?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Opened from a page in this tab: closing is "back". Otherwise (a bookmark or
  // a protected page's redirect) go to the page that was drawn behind.
  const close = useCallback(() => {
    if (openedOverStage(location.state)) navigate(-1);
    else navigate(stageHref(location.state), { replace: true });
  }, [location.state, navigate]);

  // Announce the dialog and start keyboard focus inside it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <main className="auth-stage fixed inset-0 z-50 overflow-y-auto text-foreground">
      {/* Veil: dims and softens the live scene so the card reads, without hiding it. */}
      <div aria-hidden="true" className="auth-stage-veil fixed inset-0" onClick={close} />
      <div className="relative flex min-h-full items-center justify-center px-4 py-10">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          className="auth-stage-card relative w-full max-w-sm focus:outline-none"
        >
          <button
            type="button"
            onClick={close}
            aria-label="Close sign-in and return to the live view"
            className="absolute right-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
          {children}
        </div>
      </div>
      <p
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 bottom-3 hidden text-center font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground md:block"
      >
        Live view continues behind · Esc to return
      </p>
    </main>
  );
}
