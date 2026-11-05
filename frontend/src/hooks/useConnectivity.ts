import { useState, useEffect } from 'react';
import { apiBase } from "@/lib/api/base-url";

export type ConnectivityMode = 'CLOUD' | 'SAT' | 'AIRGAP';

export interface ConnectivityStatus {
  mode: ConnectivityMode;
  latencyMs: number;
  lastChecked: string;
}

export const useConnectivity = () => {
  // Not measured yet: no latency and no check time, so nothing reads as a measured "0 ms". The mode stays CLOUD
  // (the hooks that switch to fallbacks on AIRGAP shouldn't do so before the first answer).
  const [status, setStatus] = useState<ConnectivityStatus>({
    mode: 'CLOUD',
    latencyMs: -1,
    lastChecked: '',
  });

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const proxyUrl = apiBase();
        const response = await fetch(`${proxyUrl}/api/system/connectivity`);
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) setStatus(data);
        }
      } catch (err) {
        // If server unreachable, assume AIRGAP
        if (cancelled) return;
        setStatus(prev => ({
          ...prev,
          mode: 'AIRGAP',
          latencyMs: -1,
          lastChecked: new Date().toISOString(),
        }));
      }
    };

    void fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // 30s sync
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return status;
};
