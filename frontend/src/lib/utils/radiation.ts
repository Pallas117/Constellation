/**
 * Utility functions for radiation data processing and analysis
 */

import type {
  RadiationMeasurement,
  RadiationDataPoint,
  RadiationTimeSeries,
  RadiationDataFilter,
  OrbitType,
  ParticleType,
  EnergyRange,
} from '@/lib/types/radiation';

/**
 * Filter radiation measurements based on criteria
 */
export function filterRadiationData(
  data: RadiationMeasurement[],
  filter: RadiationDataFilter
): RadiationMeasurement[] {
  let filtered = [...data];

  // Time range filter
  if (filter.startTime) {
    const start = new Date(filter.startTime);
    filtered = filtered.filter((m) => new Date(m.timestamp) >= start);
  }
  if (filter.endTime) {
    const end = new Date(filter.endTime);
    filtered = filtered.filter((m) => new Date(m.timestamp) <= end);
  }

  // Orbit type filter
  if (filter.orbitTypes && filter.orbitTypes.length > 0) {
    filtered = filtered.filter((m) => filter.orbitTypes!.includes(m.orbitType));
  }

  // Particle type filter
  if (filter.particleTypes && filter.particleTypes.length > 0) {
    filtered = filtered.filter((m) => filter.particleTypes!.includes(m.particleType));
  }

  // Energy range filter
  if (filter.energyRange) {
    filtered = filtered.filter((m) => {
      const { min, max } = filter.energyRange!;
      return (
        (m.energyRange.min >= min && m.energyRange.min <= max) ||
        (m.energyRange.max >= min && m.energyRange.max <= max) ||
        (m.energyRange.min <= min && m.energyRange.max >= max)
      );
    });
  }

  // L-shell range filter
  if (filter.L_shellRange) {
    const { min, max } = filter.L_shellRange;
    filtered = filtered.filter((m) => m.L_shell >= min && m.L_shell <= max);
  }

  // Altitude range filter
  if (filter.altitudeRange) {
    const { min, max } = filter.altitudeRange;
    filtered = filtered.filter((m) => m.altitude >= min && m.altitude <= max);
  }

  // Source filter
  if (filter.sources && filter.sources.length > 0) {
    filtered = filtered.filter((m) => filter.sources!.includes(m.source));
  }

  // Radiation zone filter
  if (filter.radiationZones && filter.radiationZones.length > 0) {
    filtered = filtered.filter((m) => {
      const zone = m.radiationZone || getRadiationZone(m);
      return filter.radiationZones!.includes(zone);
    });
  }

  // Limit results
  if (filter.limit && filter.limit > 0) {
    filtered = filtered.slice(0, filter.limit);
  }

  return filtered;
}

export const RADIATION_ZONES: RadiationZone[] = [
  'inner-belt-low',
  'inner-belt-high',
  'slot-region',
  'outer-belt-inner',
  'outer-belt-middle',
  'outer-belt-outer',
  'magnetosphere',
];

export function getRadiationZone(measurement: RadiationMeasurement): RadiationZone {
  const l = measurement.L_shell;
  const altitude = measurement.altitude;

  // Inner belt split by L-shell
  if (l <= 1.5) {
    return 'inner-belt-low';
  }
  if (l <= 2.0) {
    return 'inner-belt-high';
  }

  // Slot region between inner and outer belts
  if (l <= 3.0) {
    return 'slot-region';
  }

  // Outer belt segmented in three regions
  if (l <= 4.5) {
    return 'outer-belt-inner';
  }
  if (l <= 5.5) {
    return 'outer-belt-middle';
  }
  if (l <= 7.0) {
    return 'outer-belt-outer';
  }

  // Anything beyond the outer belt is treated as magnetospheric
  return 'magnetosphere';
}

/**
 * Convert RadiationMeasurement to RadiationDataPoint
 */
export function toDataPoint(measurement: RadiationMeasurement): RadiationDataPoint {
  return {
    timestamp: measurement.timestamp,
    flux: measurement.particleFlux,
    altitude: measurement.altitude,
    L_shell: measurement.L_shell,
    latitude: measurement.latitude,
    longitude: measurement.longitude,
    orbitType: measurement.orbitType,
    particleType: measurement.particleType,
    energyRange: measurement.energyRange,
    radiationZone: measurement.radiationZone || getRadiationZone(measurement),
  };
  return {
    timestamp: measurement.timestamp,
    flux: measurement.particleFlux,
    altitude: measurement.altitude,
    L_shell: measurement.L_shell,
    latitude: measurement.latitude,
    longitude: measurement.longitude,
    orbitType: measurement.orbitType,
    particleType: measurement.particleType,
    energyRange: measurement.energyRange,
  };
}

/**
 * Create time series from measurements
 */
export function createTimeSeries(
  measurements: RadiationMeasurement[],
  orbitType?: OrbitType,
  particleType?: ParticleType,
  energyRange?: EnergyRange
): RadiationTimeSeries {
  if (measurements.length === 0) {
    throw new Error('Cannot create time series from empty measurements');
  }

  // Filter if specific parameters provided
  let filtered = measurements;
  if (orbitType) {
    filtered = filtered.filter((m) => m.orbitType === orbitType);
  }
  if (particleType) {
    filtered = filtered.filter((m) => m.particleType === particleType);
  }
  if (energyRange) {
    filtered = filtered.filter((m) => {
      return (
        (m.energyRange.min >= energyRange.min && m.energyRange.min <= energyRange.max) ||
        (m.energyRange.max >= energyRange.min && m.energyRange.max <= energyRange.max)
      );
    });
  }

  // Check if filtering resulted in empty array
  if (filtered.length === 0) {
    throw new Error(
      `No measurements match the criteria: ${orbitType ? `orbitType=${orbitType}` : ''} ${particleType ? `particleType=${particleType}` : ''} ${energyRange ? `energyRange=${energyRange.min}-${energyRange.max}MeV` : ''}`
    );
  }

  // Sort by timestamp
  filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const dataPoints = filtered.map(toDataPoint);
  const timestamps = dataPoints.map((d) => new Date(d.timestamp).getTime());

  return {
    data: dataPoints,
    startTime: dataPoints[0].timestamp,
    endTime: dataPoints[dataPoints.length - 1].timestamp,
    orbitType: orbitType || filtered[0].orbitType,
    particleType: particleType || filtered[0].particleType,
    energyRange: energyRange || filtered[0].energyRange,
    source: filtered[0].source,
  };
}

/**
 * Calculate statistics for radiation data
 */
export function calculateStatistics(measurements: RadiationMeasurement[]): {
  count: number;
  averageFlux: number;
  medianFlux: number;
  minFlux: number;
  maxFlux: number;
  stdDevFlux: number;
  averageAltitude: number;
  averageLShell: number;
  timeSpan: {
    start: string;
    end: string;
    duration: number; // milliseconds
  };
} {
  if (measurements.length === 0) {
    return {
      count: 0,
      averageFlux: 0,
      medianFlux: 0,
      minFlux: 0,
      maxFlux: 0,
      stdDevFlux: 0,
      averageAltitude: 0,
      averageLShell: 0,
      timeSpan: {
        start: new Date().toISOString(),
        end: new Date().toISOString(),
        duration: 0,
      },
    };
  }

  const fluxes = measurements.map((m) => m.particleFlux).sort((a, b) => a - b);
  const altitudes = measurements.map((m) => m.altitude);
  const lShells = measurements.map((m) => m.L_shell);
  const timestamps = measurements.map((m) => new Date(m.timestamp).getTime());

  const sum = fluxes.reduce((a, b) => a + b, 0);
  const averageFlux = sum / fluxes.length;
  // Calculate median correctly for both odd and even-length arrays
  const medianFlux = fluxes.length % 2 === 0
    ? (fluxes[fluxes.length / 2 - 1] + fluxes[fluxes.length / 2]) / 2
    : fluxes[Math.floor(fluxes.length / 2)];
  const minFlux = fluxes[0];
  const maxFlux = fluxes[fluxes.length - 1];

  const variance =
    fluxes.reduce((acc, flux) => acc + Math.pow(flux - averageFlux, 2), 0) / fluxes.length;
  const stdDevFlux = Math.sqrt(variance);

  const averageAltitude = altitudes.reduce((a, b) => a + b, 0) / altitudes.length;
  const averageLShell = lShells.reduce((a, b) => a + b, 0) / lShells.length;

  const minTime = timestamps.reduce((min, t) => Math.min(min, t), Infinity);
  const maxTime = timestamps.reduce((max, t) => Math.max(max, t), -Infinity);

  return {
    count: measurements.length,
    averageFlux,
    medianFlux,
    minFlux,
    maxFlux,
    stdDevFlux,
    averageAltitude,
    averageLShell,
    timeSpan: {
      start: new Date(minTime).toISOString(),
      end: new Date(maxTime).toISOString(),
      duration: maxTime - minTime,
    },
  };
}

/**
 * Group measurements by orbit type
 */
export function groupByOrbitType(
  measurements: RadiationMeasurement[]
): Record<OrbitType, RadiationMeasurement[]> {
  const grouped: Record<OrbitType, RadiationMeasurement[]> = {
    LEO: [],
    MEO: [],
    GEO: [],
  };

  measurements.forEach((m) => {
    grouped[m.orbitType].push(m);
  });

  return grouped;
}

/**
 * Group measurements by particle type
 */
export function groupByParticleType(
  measurements: RadiationMeasurement[]
): Record<ParticleType, RadiationMeasurement[]> {
  const grouped: Partial<Record<ParticleType, RadiationMeasurement[]>> = {};

  measurements.forEach((m) => {
    if (!grouped[m.particleType]) {
      grouped[m.particleType] = [];
    }
    grouped[m.particleType]!.push(m);
  });

  return grouped as Record<ParticleType, RadiationMeasurement[]>;
}

/**
 * Interpolate missing data points in time series
 */
export function interpolateTimeSeries(
  timeSeries: RadiationTimeSeries,
  intervalMs: number = 60000 // 1 minute default
): RadiationTimeSeries {
  if (timeSeries.data.length < 2) {
    return timeSeries;
  }

  const interpolated: RadiationDataPoint[] = [];
  const startTime = new Date(timeSeries.startTime).getTime();
  const endTime = new Date(timeSeries.endTime).getTime();

  // Create a map of existing data points by timestamp
  const dataMap = new Map<number, RadiationDataPoint>();
  timeSeries.data.forEach((point) => {
    const time = new Date(point.timestamp).getTime();
    dataMap.set(time, point);
  });

  // Interpolate for each interval
  for (let time = startTime; time <= endTime; time += intervalMs) {
    if (dataMap.has(time)) {
      interpolated.push(dataMap.get(time)!);
    } else {
      // Find surrounding points for interpolation
      const before = findNearestBefore(dataMap, time);
      const after = findNearestAfter(dataMap, time);

      if (before && after) {
        const t = (time - before.time) / (after.time - before.time);
        interpolated.push({
          timestamp: new Date(time).toISOString(),
          flux: lerp(before.point.flux, after.point.flux, t),
          altitude: lerp(before.point.altitude, after.point.altitude, t),
          L_shell: lerp(before.point.L_shell, after.point.L_shell, t),
          latitude: before.point.latitude && after.point.latitude
            ? lerp(before.point.latitude, after.point.latitude, t)
            : before.point.latitude || after.point.latitude,
          longitude: before.point.longitude && after.point.longitude
            ? lerp(before.point.longitude, after.point.longitude, t)
            : before.point.longitude || after.point.longitude,
          orbitType: timeSeries.orbitType,
          particleType: timeSeries.particleType,
          energyRange: timeSeries.energyRange,
        });
      } else if (before) {
        interpolated.push(before.point);
      } else if (after) {
        interpolated.push(after.point);
      }
    }
  }

  return {
    ...timeSeries,
    data: interpolated,
  };
}

/**
 * Helper function for interpolation
 */
function findNearestBefore(
  dataMap: Map<number, RadiationDataPoint>,
  time: number
): { time: number; point: RadiationDataPoint } | null {
  let nearest: { time: number; point: RadiationDataPoint } | null = null;
  let minDiff = Infinity;

  dataMap.forEach((point, pointTime) => {
    if (pointTime <= time) {
      const diff = time - pointTime;
      if (diff < minDiff) {
        minDiff = diff;
        nearest = { time: pointTime, point };
      }
    }
  });

  return nearest;
}

function findNearestAfter(
  dataMap: Map<number, RadiationDataPoint>,
  time: number
): { time: number; point: RadiationDataPoint } | null {
  let nearest: { time: number; point: RadiationDataPoint } | null = null;
  let minDiff = Infinity;

  dataMap.forEach((point, pointTime) => {
    if (pointTime >= time) {
      const diff = pointTime - time;
      if (diff < minDiff) {
        minDiff = diff;
        nearest = { time: pointTime, point };
      }
    }
  });

  return nearest;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Determine alert level based on flux values
 */
export function getAlertLevel(flux: number, particleType: ParticleType): 'low' | 'moderate' | 'high' | 'severe' {
  // Thresholds in particles/(cm²·s·sr·MeV) - these are example values
  const thresholds = {
    electron: { moderate: 1e4, high: 1e5, severe: 1e6 },
    proton: { moderate: 1e2, high: 1e3, severe: 1e4 },
    alpha: { moderate: 1e1, high: 1e2, severe: 1e3 },
    heavy_ion: { moderate: 1e0, high: 1e1, severe: 1e2 },
  };

  const thresh = thresholds[particleType] || thresholds.electron;

  if (flux >= thresh.severe) return 'severe';
  if (flux >= thresh.high) return 'high';
  if (flux >= thresh.moderate) return 'moderate';
  return 'low';
}

