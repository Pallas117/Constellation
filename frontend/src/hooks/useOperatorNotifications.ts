import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSolarWind5s } from "@/hooks/useSolarWind5s";
import { measuredDrivers } from "@/lib/measured";

/** Radiation storms (NOAA S-scale) have their own toast: different hazard, different actions. */
const RADIATION_TOAST_ID = "radiation-storm";

/** One toast, updated in place as conditions change, so a long storm never stacks alerts. */
const TOAST_ID = "space-weather";

/** Storm alerts for the operator console, raised once per change of conditions. */
export function useOperatorNotifications() {
  // The latest point is enough (and L1 data is 1-minute cadence): no 24 h backfill.
  const solarWind = useSolarWind5s({ history: false });
  const navigate = useNavigate();
  const lastNotificationRef = useRef<string | null>(null);
  const lastRadiationRef = useRef<string>("none");

  useEffect(() => {
    const point = solarWind.latest;
    if (!point) {
      return;
    }

    // Radiation storms are a separate stream, with their own toast and actions (GAU-135).
    const radiation = point.alerts?.radiation;
    const radiationKey = radiation?.level != null && radiation.level >= 1 ? radiation.label : "none";
    if (radiationKey !== lastRadiationRef.current) {
      lastRadiationRef.current = radiationKey;
      if (!radiation || radiationKey === "none") {
        toast.dismiss(RADIATION_TOAST_ID);
      } else {
        const severe = (radiation.level ?? 0) >= 3;
        (severe ? toast.error : toast.warning)(`${radiation.label} radiation storm`, {
          id: RADIATION_TOAST_ID,
          description: `${radiation.basis}. Energetic particles raise single-event upset and detector-hit rates: watch EDAC and SEU counters and defer sensitive operations. This is separate from geomagnetic conditions.`,
          duration: severe ? Infinity : 20000,
        });
      }
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
      notify = () => toast.error("Critical geomagnetic storm alert", { id: TOAST_ID, description, duration: Infinity, action: protect });
    } else if (kp >= 4 || bz <= -4 || speed >= 600) {
      const description = `Geomagnetic stress is building (Kp ${kp}, Bz ${bz.toFixed(1)} nT). Review thermal margins and plan workload reductions.`;
      fingerprint = `elevated:${description}`;
      notify = () => toast.warning("Elevated geomagnetic risk", { id: TOAST_ID, description, duration: 20000, action: protect });
    } else if (bz >= 3 && speed < 450 && kp <= 2 && radiation?.level === 0) {
      // A window needs both streams measured and quiet: a radiation storm can run under a quiet field.
      const description = "Calm solar wind, northward IMF and no radiation storm: a low-risk window for attitude manoeuvres and uplinks.";
      fingerprint = `window:${description}`;
      notify = () => toast.success("Safe opportunity window", { id: TOAST_ID, description, duration: 12000 });
    } else {
      // This stream speaks for geomagnetic conditions only; radiation has its own toast.
      const description = "Solar wind and Kp are quiet. Radiation storms are reported separately.";
      fingerprint = `nominal:${description}`;
      notify = () => toast("Geomagnetic conditions quiet", { id: TOAST_ID, description, duration: 8000 });
    }

    if (fingerprint === lastNotificationRef.current) {
      return;
    }
    lastNotificationRef.current = fingerprint;
    notify();
  }, [solarWind.latest, navigate]);
}
