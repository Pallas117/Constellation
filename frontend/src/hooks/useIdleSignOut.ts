import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { ACTIVITY_STORAGE_KEY, idleLimitMs, idlePhase, latestActivity } from "@/lib/idle";

const LIMIT_MS = idleLimitMs(import.meta.env?.VITE_IDLE_SIGNOUT_MINUTES);
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
const TOAST_ID = "idle-sign-out";

function readShared(): string | null {
  try {
    return window.localStorage.getItem(ACTIVITY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeShared(at: number): void {
  try {
    window.localStorage.setItem(ACTIVITY_STORAGE_KEY, String(at));
  } catch {
    // Private mode or storage blocked: this tab still keeps its own clock.
  }
}

/**
 * Signs the operator out after VITE_IDLE_SIGNOUT_MINUTES (default 15) with no
 * input in any Gauss tab, warning a minute before (lib/idle.ts). `enabled`
 * is for operator and admin sessions.
 */
export function useIdleSignOut(enabled: boolean, signOut: () => void) {
  const signOutRef = useRef(signOut);
  useEffect(() => {
    signOutRef.current = signOut;
  }, [signOut]);

  useEffect(() => {
    if (!enabled || LIMIT_MS === 0) return;
    let last = Date.now();
    let lastWrite = 0;
    let warned = false;
    let done = false;
    writeShared(last);

    const check = () => {
      if (done) return;
      const now = Date.now();
      last = latestActivity(last, readShared(), now);
      const { phase, remainingMs } = idlePhase(last, now, LIMIT_MS);
      if (phase === "expired") {
        done = true;
        toast.dismiss(TOAST_ID);
        signOutRef.current();
      } else if (phase === "warning" && !warned) {
        warned = true;
        toast.warning(`Signing you out in ${Math.ceil(remainingMs / 1000)} s`, {
          id: TOAST_ID,
          description: "No activity for a while. Move the mouse or press a key to stay signed in.",
          duration: remainingMs,
        });
      } else if (phase === "active" && warned) {
        warned = false;
        toast.dismiss(TOAST_ID);
      }
    };

    const onActivity = () => {
      // Expiry first: coming back to a long-idle tab must not count as staying.
      check();
      if (done) return;
      last = Date.now();
      if (last - lastWrite > 5_000) {
        lastWrite = last;
        writeShared(last);
      }
      if (warned) check();
    };
    const onVisible = () => document.visibilityState === "visible" && check();

    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(check, 5_000);
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      toast.dismiss(TOAST_ID);
    };
  }, [enabled]);
}
