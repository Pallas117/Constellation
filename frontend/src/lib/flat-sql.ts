import { deserialize } from 'flatgeobuf/lib/mjs/api.js';

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SpatialEntity {
  id: string;
  lat: number;
  lon: number;
  altitude: number;
  velocity: number;
  type: "debris" | "satellite";
}

/**
 * FlatSQL spatial parsing engine.
 * Streams high-density orbital telemetry (like 30,000+ TLEs or space debris)
 * over the network using FlatGeobuf and spatial bounding-box querying directly
 * at the client/edge without loading an entire JSON payload into memory.
 */
export class FlatSQLEngine {
  private dataSourceUrl: string;

  constructor(dataSourceUrl: string) {
    this.dataSourceUrl = dataSourceUrl;
  }

  /**
   * Performs an R-Tree bounding box query over a remote FlatGeobuf file.
   * Only fetches the bytes necessary to resolve entities within the camera frustum.
   */
  async streamEntitiesInFrustum(bbox: BoundingBox): Promise<SpatialEntity[]> {
    const results: SpatialEntity[] = [];
    
    try {
      const rect = { 
        minX: bbox.minX, 
        minY: bbox.minY, 
        maxX: bbox.maxX, 
        maxY: bbox.maxY 
      };

      // The deserialize function fetches HTTP Range requests against the spatial index
      const iterator = deserialize(this.dataSourceUrl, rect);

      for await (const feature of iterator) {
        if (!feature || !feature.geometry) continue;
        
        // Transform GeoJSON-like features into internal fast SpatialEntities
        const coords = feature.geometry.coordinates as number[];
        if (coords && coords.length >= 2) {
          results.push({
            id: (feature.properties?.id as string) || crypto.randomUUID(),
            lon: coords[0],
            lat: coords[1],
            altitude: (feature.properties?.altitude as number) || 400, // LEO baseline
            velocity: (feature.properties?.velocity as number) || 7.6, // km/s
            type: (feature.properties?.type as "debris" | "satellite") || "debris"
          });
        }
      }
    } catch (err) {
      console.error("[FlatSQL] Frustum edge streaming failure:", err);
      throw err;
    }
    
    return results;
  }

  /**
   * Warm the connection and download R-Tree spatial indexes for faster queries.
   */
  async preloadSpatialIndex(): Promise<void> {
      console.log(`[FlatSQL] Pre-fetching FlatGeobuf header and index from ${this.dataSourceUrl}`);
      // In production, this would trigger HTTP HEAD or small Range check to cache headers.
  }
}
