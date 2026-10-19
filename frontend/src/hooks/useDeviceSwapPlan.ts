import { useCallback, useEffect, useState } from "react";
import { getDeviceSwapPlan, requestDeviceSwapRebalance, type DeviceSwapPlan } from "@/lib/api/device-swap";

type PlanResult = { plan: DeviceSwapPlan; error: null } | { plan: null; error: string };

async function loadPlan(): Promise<PlanResult> {
  try {
    return { plan: await getDeviceSwapPlan(), error: null };
  } catch (err) {
    return { plan: null, error: err instanceof Error ? err.message : "Unable to fetch SWAP plan" };
  }
}

export function useDeviceSwapPlan() {
  const [plan, setPlan] = useState<DeviceSwapPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [rebalanceMessage, setRebalanceMessage] = useState<string | null>(null);

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

  const rebalance = useCallback(async () => {
    setLoading(true);
    setRebalanceMessage(null);
    try {
      const nextPlan = await requestDeviceSwapRebalance();
      setPlan(nextPlan);
      setLastUpdated(new Date());
      setRebalanceMessage("SWAP rebalance executed successfully.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rebalance SWAP network");
      setRebalanceMessage(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Background polls keep the last plan on screen instead of flipping `loading` each minute.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const result = await loadPlan();
      if (!cancelled) applyPlan(result);
    };
    void poll();
    const interval = window.setInterval(poll, 60000);
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
    fetchPlan,
    rebalance,
  };
}
