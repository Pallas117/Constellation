import { useEffect, useRef } from "react";
import { toast } from "@/components/ui/sonner";
import { useSolarWind5s } from "@/hooks/useSolarWind5s";

export function useOperatorNotifications() {
  const solarWind = useSolarWind5s();
  const lastNotificationRef = useRef<string | null>(null);

  useEffect(() => {
    const point = solarWind.latest;
    if (!point) {
      return;
    }

    const kp = point.indices?.kp ?? 0;
    const bz = point.magneticField?.z ?? 0;
    const speed = point.solarWind.speed ?? 0;

    let title = "";
    let description = "";
    let variant: "default" | "success" | "destructive" = "default";

    if (kp >= 6 || bz <= -8 || speed >= 700) {
      title = "Critical Space Weather Alert";
      description = `Severe conditions detected: Kp ${kp}, IMF Bz ${bz.toFixed(1)} nT, solar wind ${Math.round(speed)} km/s. Execute protective actions now.`;
      variant = "destructive";
    } else if (kp >= 4 || bz <= -4 || speed >= 600) {
      title = "Elevated Space Risk";
      description = `High geomagnetic stress is building (${kp} Kp, ${bz.toFixed(1)} nT Bz). Review thermal margins and schedule workload reductions.`;
      variant = "destructive";
    } else if (bz >= 3 && speed < 450 && kp <= 2) {
      title = "Safe Opportunity Window";
      description = `Calm solar wind and northward IMF are creating a low-risk window for attitude maneuvers and communications uplink.`;
      variant = "success";
    } else {
      title = "Stable Operator Status";
      description = `Space weather is nominal. Continue monitoring, but primary systems remain within safe margins.`;
      variant = "default";
    }

    const fingerprint = `${title}:${description}`;
    if (fingerprint === lastNotificationRef.current) {
      return;
    }

    lastNotificationRef.current = fingerprint;
    // sonner has no `variant` option; severity is chosen by the toast function.
    const notify = variant === "destructive" ? toast.error : variant === "success" ? toast.success : toast;
    notify(title, {
      description,
      duration: 12000,
      action: {
        label: "View status",
        onClick: () => {
          window.location.href = "/operator";
        },
      },
    });
  }, [solarWind.latest]);
}
