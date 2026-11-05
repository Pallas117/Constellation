import { useState, useEffect } from 'react';
import { apiBase } from "@/lib/api/base-url";

export type ConnectivityMode = 'CLOUD' | 'SAT' | 'AIRGAP';

export interface ConnectivityStatus {
  mode: ConnectivityMode;
  latencyMs: number;
  lastChecked: string;
}

export const useConnectivity = () => {
  const [status, setStatus] = useState<ConnectivityStatus>({
    mode: 'CLOUD',
    latencyMs: 0,
    lastChecked: new Date().toISOString(),
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
