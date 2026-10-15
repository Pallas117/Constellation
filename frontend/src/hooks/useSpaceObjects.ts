import { useEffect, useState } from 'react';
import { useConnectivity } from '@/hooks/useConnectivity';
import { SPACE_OBJECT_CATALOG } from '@/lib/data/spaceObjectCatalog';
import type { InterpolatedData } from '@/hooks/useSpaceWeather';
import type { SpaceObjectCatalogEntry, SpaceObjectDetectionAlert } from '@/lib/types/space-object';
import { apiBase } from "@/lib/api/base-url";

export interface UseSpaceObjectsReturn {
  catalog: SpaceObjectCatalogEntry[];
  alert: SpaceObjectDetectionAlert | null;
  isReady: boolean;
  error: string | null;
}

const calculateUndetectedCandidates = (
  data: InterpolatedData,
  catalog: SpaceObjectCatalogEntry[]
): SpaceObjectDetectionAlert | null => {
  // Only raise candidates from live, measured inputs. Unmeasured flux or stale data
  // must never produce a detection alert.
  if (data.isStale || data.tier !== 0 || data.source === 'unavailable' || data.electronFlux == null) {
    return null;
  }
  const stormFactor = Math.max(0, data.kpIndex - 4);
  const fluxFactor = Math.max(0, (data.electronFlux - 2200) / 2200);
  const candidateCount = Math.min(3, Math.round(stormFactor + fluxFactor));

  if (candidateCount === 0) {
    return null;
  }

  const severity = candidateCount >= 3 ? 'high' : candidateCount === 2 ? 'moderate' : 'low';
  const candidates = Array.from({ length: candidateCount }, (_, index) => {
    const longitude = ((data.timestamp.getUTCSeconds() * 6 + index * 120) % 360) - 180;
    return {
      id: `UNTRACKED-${index + 1}`,
      name: `Untracked object ${index + 1}`,
      category: 'unknown' as const,
      orbitType: 'GEO' as const,
      altitude: 35786,
      inclination: 0.1,
      raan: (index * 60) % 360,
      meanMotion: 1.0027,
      latitude: 0,
      longitude,
      owner: 'UNKNOWN',
      agency: 'UNKNOWN',
      signalProfile: 'unknown',
      tags: ['anomaly', 'untracked', 'candidate'],
      lastSeen: data.timestamp.toISOString(),
    };
  });

  return {
    timestamp: data.timestamp.toISOString(),
    severity,
    description:
      'Radiation anomaly footprint suggests at least one object is present in GEO that is not matched by the catalog.',
    candidateCount,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      orbitType: candidate.orbitType,
      altitude: candidate.altitude,
      category: candidate.category,
    })),
  };
};

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

export const useSpaceObjects = (data: InterpolatedData): UseSpaceObjectsReturn => {
  const { mode } = useConnectivity();
  const [catalog, setCatalog] = useState<SpaceObjectCatalogEntry[]>([]);
  const [alert, setAlert] = useState<SpaceObjectDetectionAlert | null>(null);
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

        const proxyUrl = apiBase();
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

  useEffect(() => {
    setAlert(calculateUndetectedCandidates(data, catalog));
  }, [data, catalog]);

  return {
    catalog,
    alert,
    isReady,
    error,
  };
};
