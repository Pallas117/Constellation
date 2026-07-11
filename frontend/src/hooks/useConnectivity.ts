import { useState, useEffect } from 'react';

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

  const fetchStatus = async () => {
    try {
      const proxyUrl = import.meta.env.VITE_HELIO_PROXY_URL || 'http://127.0.0.1:3001';
      const response = await fetch(`${proxyUrl}/api/system/connectivity`);
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
      }
    } catch (err) {
      // If server unreachable, assume AIRGAP
      setStatus(prev => ({
        ...prev,
        mode: 'AIRGAP',
        latencyMs: -1,
        lastChecked: new Date().toISOString(),
      }));
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000); // 30s sync
    return () => clearInterval(interval);
  }, []);

  return status;
};
