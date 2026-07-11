/**
 * Catalog and detection types for orbital objects and SSA cross-references.
 */

export type OrbitType = 'LEO' | 'MEO' | 'GEO';
export type SpaceObjectCategory = 'satellite' | 'rocket_body' | 'debris' | 'unknown';

export interface SpaceObjectCatalogEntry {
  id: string;
  name: string;
  category: SpaceObjectCategory;
  orbitType: OrbitType;
  altitude: number;
  inclination: number;
  raan: number;
  meanMotion: number;
  latitude?: number;
  longitude?: number;
  owner?: string;
  agency?: string;
  signalProfile?: 'telemetry' | 'radar' | 'optical' | 'unknown';
  tags?: string[];
  lastSeen?: string;
}

export interface SpaceObjectDetectionAlert {
  timestamp: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  description: string;
  candidateCount: number;
  candidates: Array<Pick<SpaceObjectCatalogEntry, 'id' | 'name' | 'orbitType' | 'altitude' | 'category'>>;
}
