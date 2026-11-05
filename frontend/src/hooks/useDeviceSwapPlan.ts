import { useCallback, useEffect, useState } from "react";
import { getDeviceSwapPlan, requestDeviceSwapRebalance, type DeviceSwapPlan } from "@/lib/api/device-swap";
import { HttpFailure } from "@/lib/api/http-error";
import { stopsPolling } from "@/lib/mesh-onboarding";

type PlanResult = { plan: DeviceSwapPlan; error: null; stop?: false } | { plan: null; error: string; stop: boolean };

async function loadPlan(): Promise<PlanResult> {
  try {
    return { plan: await getDeviceSwapPlan(), error: null };
  } catch (err) {
    // A 401/403 ends polling: CyberTiger counts them and blocks the address.
    const stop = err instanceof HttpFailure && stopsPolling(err.status);
    return { plan: null, error: err instanceof Error ? err.message : "Unable to fetch SWAP plan", stop };
  }
}

export function useDeviceSwapPlan() {
  const [plan, setPlan] = useState<DeviceSwapPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [rebalanceMessage, setRebalanceMessage] = useState<string | null>(null);
  const [rebalanceFailed, setRebalanceFailed] = useState(false);

  const applyPlan = useCallback((result: PlanResult) => {
    if (result.plan) {
      setPlan(result.plan);
      setLastUpdated(new Date());
    }
    setError(result.error);
    setLoading(false);
  }, []);

  const fetchPlan = useCallback(async () => {
    setLoading(true);
    setError(null);
    applyPlan(await loadPlan());
  }, [applyPlan]);

  // The button shows its own pending state; a failed rebalance is reported beside it and leaves the plan on screen.
  const rebalance = useCallback(async () => {
    setRebalanceMessage(null);
    setRebalanceFailed(false);
    try {
      const nextPlan = await requestDeviceSwapRebalance();
      setPlan(nextPlan);
      setLastUpdated(new Date());
      const at = new Date().toISOString().slice(11, 19);
      setRebalanceMessage(nextPlan.message ? `${nextPlan.message} (${at} UTC).` : `Rebalanced at ${at} UTC.`);
    } catch (err) {
      setRebalanceMessage(err instanceof Error ? err.message : "Couldn't rebalance the SWAP network.");
      setRebalanceFailed(true);
    }
  }, []);

  // Background polls keep the last plan on screen instead of flipping `loading` each minute.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const result = await loadPlan();
      if (cancelled) return;
      applyPlan(result);
      if (result.stop) window.clearInterval(interval);
    };
    const interval = window.setInterval(poll, 60000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [applyPlan]);

  return {
    plan,
    loading,
    error,
    lastUpdated,
    rebalanceMessage,
    rebalanceFailed,
    fetchPlan,
    rebalance,
  };
}
