import { useCallback, useEffect, useState } from "react";
import { getDeviceSwapPlan, requestDeviceSwapRebalance, type DeviceSwapPlan } from "@/lib/api/device-swap";

export function useDeviceSwapPlan() {
  const [plan, setPlan] = useState<DeviceSwapPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [rebalanceMessage, setRebalanceMessage] = useState<string | null>(null);

  const fetchPlan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextPlan = await getDeviceSwapPlan();
      setPlan(nextPlan);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to fetch SWAP plan");
    } finally {
      setLoading(false);
    }
  }, []);

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

  useEffect(() => {
    fetchPlan();
    const interval = window.setInterval(fetchPlan, 60000);
    return () => window.clearInterval(interval);
  }, [fetchPlan]);

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
