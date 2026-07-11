/**
 * Shared type definitions for Space Weather visualization components.
 * Single source of truth — imported by GaussGlobe, Nav, SpaceWeatherVisualization, etc.
 */

export interface LayerVisibility {
  earth: boolean;
  belts: boolean;
  magnetosphere: boolean;
  fieldLines: boolean;
  mhdWaves: boolean;
  mmsReconnection: boolean;
}

export type EncodingMode = 'color' | 'size' | 'both';
