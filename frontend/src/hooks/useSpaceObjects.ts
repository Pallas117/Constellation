import { useEffect, useState } from 'react';
import { useConnectivity } from '@/hooks/useConnectivity';
import { SPACE_OBJECT_CATALOG } from '@/lib/data/spaceObjectCatalog';
import type { InterpolatedData } from '@/hooks/useSpaceWeather';
import type { SpaceObjectCatalogEntry, SpaceObjectDetectionAlert } from '@/lib/types/space-object';

export interface UseSpaceObjectsReturn {
  catalog: SpaceObjectCatalogEntry[];
  alert: SpaceObjectDetectionAlert | null;
  isReady: boolean;
  error: string | null;
}

const fetchRemoteCatalog = async (proxyUrl: string): Promise<SpaceObjectCatalogEntry[]> => {
  const response = await fetch(`${proxyUrl}/api/feed/space-objects`);
  if (!response.ok) {
    throw new Error(`Failed to fetch space object catalog: HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.objects)) {
    throw new Error('Invalid space object feed format');
  }
  return data.objects as SpaceObjectCatalogEntry[];
};

export const useSpaceObjects = (_data: InterpolatedData): UseSpaceObjectsReturn => {
  const { mode } = useConnectivity();
  const [catalog, setCatalog] = useState<SpaceObjectCatalogEntry[]>([]);
  // No detection source is connected (GAU-89). A Kp/flux heuristic used to invent "untracked GEO
  // objects" here, with longitudes taken from the clock; until a real detector feeds this, the
  // alert stays empty rather than showing objects nobody observed.
  const alert: SpaceObjectDetectionAlert | null = null;
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadCatalog = async () => {
      try {
        if (mode === 'AIRGAP') {
          setCatalog(SPACE_OBJECT_CATALOG);
          setIsReady(true);
          setError(null);
          return;
        }

        const proxyUrl = import.meta.env.VITE_HELIO_PROXY_URL || 'http://127.0.0.1:3001';
        const remoteCatalog = await fetchRemoteCatalog(proxyUrl);
        if (!active) return;

        setCatalog(remoteCatalog.length > 0 ? remoteCatalog : SPACE_OBJECT_CATALOG);
        setIsReady(true);
        setError(null);
      } catch (err) {
        if (!active) return;
        console.warn('[SpaceObjects] Remote catalog unavailable, using local fallback', err);
        setCatalog(SPACE_OBJECT_CATALOG);
        setIsReady(true);
        setError(err instanceof Error ? err.message : 'Unknown catalog load failure');
      }
    };

    loadCatalog();
    return () => {
      active = false;
    };
  }, [mode]);

  return {
    catalog,
    alert,
    isReady,
    error,
  };
};
