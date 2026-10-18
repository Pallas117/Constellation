import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "@/components/ui/sonner";
import { useSolarWind5s } from "@/hooks/useSolarWind5s";
import { measuredDrivers } from "@/lib/measured";

/** One toast, updated in place as conditions change, so a long storm never stacks alerts. */
const TOAST_ID = "space-weather";

/** Storm alerts for the operator console, raised once per change of conditions. */
export function useOperatorNotifications() {
  // The latest point is enough (and L1 data is 1-minute cadence): no 24 h backfill.
  const solarWind = useSolarWind5s({ history: false });
  const navigate = useNavigate();
  const lastNotificationRef = useRef<string | null>(null);

  useEffect(() => {
    const point = solarWind.latest;
    if (!point) {
      return;
    }

    // Missing or stale data is unknown, never "nominal" (GAU-114). Same toast id,
    // so it also replaces a standing storm alert rather than sitting beside it.
    const measured = measuredDrivers(point);
    if (!measured) {
      if (lastNotificationRef.current !== "unknown") {
        lastNotificationRef.current = "unknown";
        toast("Space weather data unavailable", {
          id: TOAST_ID,
          description: "No current measurement: conditions are unknown, not nominal.",
          duration: 12000,
        });
      }
      return;
    }

    const { kp, bz, speed } = measured;
    const protect = { label: "Open protection", onClick: () => navigate("/protection") };

    let notify: () => void;
    let fingerprint: string;
    if (kp >= 6 || bz <= -8 || speed >= 700) {
      const description = `Severe conditions: Kp ${kp}, IMF Bz ${bz.toFixed(1)} nT, solar wind ${Math.round(speed)} km/s. Take protective actions now.`;
      fingerprint = `critical:${description}`;
      notify = () => toast.error("Critical space weather alert", { id: TOAST_ID, description, duration: Infinity, action: protect });
    } else if (kp >= 4 || bz <= -4 || speed >= 600) {
      const description = `Geomagnetic stress is building (Kp ${kp}, Bz ${bz.toFixed(1)} nT). Review thermal margins and plan workload reductions.`;
      fingerprint = `elevated:${description}`;
      notify = () => toast.warning("Elevated space weather risk", { id: TOAST_ID, description, duration: 20000, action: protect });
    } else if (bz >= 3 && speed < 450 && kp <= 2) {
      const description = "Calm solar wind and northward IMF: a low-risk window for attitude manoeuvres and uplinks.";
      fingerprint = `window:${description}`;
      notify = () => toast.success("Safe opportunity window", { id: TOAST_ID, description, duration: 12000 });
    } else {
      const description = "Space weather is nominal; primary systems are within safe margins.";
      fingerprint = `nominal:${description}`;
      notify = () => toast("Conditions nominal", { id: TOAST_ID, description, duration: 8000 });
    }

    if (fingerprint === lastNotificationRef.current) {
      return;
    }
    lastNotificationRef.current = fingerprint;
    notify();
  }, [solarWind.latest, navigate]);
}
