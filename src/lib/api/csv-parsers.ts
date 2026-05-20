/**
 * CSV parsers for Asian space radiation datasets
 * - ERG/Arase (Exploration of Energization and Radiation in Geospace)
 * - CSES (China Seismo-Electromagnetic Satellite)
 */

import type { RadiationMeasurement, OrbitType, ParticleType, EnergyRange } from '@/lib/types/radiation';

export interface CSVParserOptions {
  /** Skip header row */
  skipHeader?: boolean;
  /** Column mappings (column name -> field name) */
  columnMap?: Record<string, string>;
  /** Default values for missing fields */
  defaults?: Partial<RadiationMeasurement>;
}

/**
 * Parse ERG/Arase CSV data format
 * ERG/Arase typically provides electron and proton flux data
 */
export function parseERGAraseCSV(
  csvContent: string,
  options: CSVParserOptions = {}
): RadiationMeasurement[] {
  const lines = csvContent.trim().split('\n');
  const measurements: RadiationMeasurement[] = [];
  
  // ERG/Arase CSV format (example - actual format may vary)
  // Expected columns: timestamp, energy_min, energy_max, flux, altitude, L_shell, latitude, longitude, particle_type
  const startIndex = options.skipHeader ? 1 : 0;
  
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const columns = parseCSVLine(line);
    
    if (columns.length < 5) continue; // Minimum required columns
    
    try {
      const timestamp = columns[0] ?? new Date().toISOString();
      // Use NaN checks to distinguish between missing values and actual 0
      const energyMinRaw = columns[1] ? parseFloat(columns[1]) : NaN;
      const energyMaxRaw = columns[2] ? parseFloat(columns[2]) : NaN;
      const energyMin = isNaN(energyMinRaw) ? 0 : energyMinRaw;
      // Use a boolean flag to track if energyMax is missing, rather than using null
      const hasEnergyMax = !isNaN(energyMaxRaw);
      const energyMax = hasEnergyMax ? energyMaxRaw : (energyMin * 1.2);
      const flux = parseFloat(columns[3]);
      // Handle NaN explicitly for altitude and L_shell
      const altitudeRaw = columns[4] ? parseFloat(columns[4]) : NaN;
      const altitude = isNaN(altitudeRaw) ? 400 : altitudeRaw;
      const lShellRaw = columns[5] ? parseFloat(columns[5]) : NaN;
      const L_shell = isNaN(lShellRaw) ? 1.1 : lShellRaw;
      const latitude = columns[6] ? parseFloat(columns[6]) : undefined;
      const longitude = columns[7] ? parseFloat(columns[7]) : undefined;
      const particleTypeStr = (columns[8] ?? 'electron').toLowerCase();
      
      if (isNaN(flux) || flux < 0) continue;
      
      const particleType: ParticleType = 
        particleTypeStr.includes('proton') ? 'proton' :
        particleTypeStr.includes('electron') ? 'electron' :
        particleTypeStr.includes('alpha') ? 'alpha' :
        'electron';
      
      // Determine orbit type from altitude
      const orbitType: OrbitType = 
        altitude < 2000 ? 'LEO' :
        altitude < 35786 ? 'MEO' :
        'GEO';
      
      const measurement: RadiationMeasurement = {
        timestamp: normalizeTimestamp(timestamp),
        particleFlux: flux,
        altitude,
        L_shell,
        latitude,
        longitude,
        particleType,
        energyRange: {
          min: energyMin,
          max: energyMax, // Now always a number, no null sentinel
        },
        orbitType,
        source: 'erg-arase',
        metadata: {
          instrument: 'ERG/Arase',
          quality: 'high',
        },
        ...options.defaults,
      };
      
      measurements.push(measurement);
    } catch (error) {
      console.warn(`Error parsing ERG/Arase CSV line ${i + 1}:`, error);
      continue;
    }
  }
  
  return measurements;
}

/**
 * Parse CSES (China Seismo-Electromagnetic Satellite) CSV data format
 * CSES provides electromagnetic and particle data
 */
export function parseCSESCSV(
  csvContent: string,
  options: CSVParserOptions = {}
): RadiationMeasurement[] {
  const lines = csvContent.trim().split('\n');
  const measurements: RadiationMeasurement[] = [];
  
  // CSES CSV format (example - actual format may vary)
  // Expected columns: timestamp, particle_flux, altitude, L_shell, latitude, longitude, energy_min, energy_max, particle_type
  const startIndex = options.skipHeader ? 1 : 0;
  
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const columns = parseCSVLine(line);
    
    if (columns.length < 4) continue; // Minimum required columns
    
    try {
      const timestamp = columns[0] ?? new Date().toISOString();
      const flux = parseFloat(columns[1]);
      // Use NaN checks to distinguish between missing values and actual 0
      const altitudeRaw = columns[2] ? parseFloat(columns[2]) : NaN;
      const L_shellRaw = columns[3] ? parseFloat(columns[3]) : NaN;
      const altitude = isNaN(altitudeRaw) ? 500 : altitudeRaw; // CSES is in LEO ~500km
      const L_shell = isNaN(L_shellRaw) ? 1.1 : L_shellRaw;
      const latitude = columns[4] ? parseFloat(columns[4]) : undefined;
      const longitude = columns[5] ? parseFloat(columns[5]) : undefined;
      // Use NaN checks for energy range - only fallback if truly missing (NaN), not if 0
      const energyMinRaw = columns[6] ? parseFloat(columns[6]) : NaN;
      const energyMaxRaw = columns[7] ? parseFloat(columns[7]) : NaN;
      const energyMin = isNaN(energyMinRaw) ? 0.1 : energyMinRaw;
      const energyMax = isNaN(energyMaxRaw) ? 10 : energyMaxRaw;
      const particleTypeStr = (columns[8] ?? 'electron').toLowerCase();
      
      if (isNaN(flux) || flux < 0) continue;
      
      const particleType: ParticleType = 
        particleTypeStr.includes('proton') ? 'proton' :
        particleTypeStr.includes('electron') ? 'electron' :
        particleTypeStr.includes('alpha') ? 'alpha' :
        'electron';
      
      const measurement: RadiationMeasurement = {
        timestamp: normalizeTimestamp(timestamp),
        particleFlux: flux,
        altitude,
        L_shell,
        latitude,
        longitude,
        particleType,
        energyRange: {
          min: energyMin,
          max: energyMax,
        },
        orbitType: 'LEO', // CSES is in LEO
        source: 'cses',
        metadata: {
          instrument: 'CSES',
          quality: 'high',
        },
        ...options.defaults,
      };
      
      measurements.push(measurement);
    } catch (error) {
      console.warn(`Error parsing CSES CSV line ${i + 1}:`, error);
      continue;
    }
  }
  
  return measurements;
}

/**
 * Generic CSV parser with column mapping
 */
export function parseGenericRadiationCSV(
  csvContent: string,
  options: CSVParserOptions & {
    source: 'erg-arase' | 'cses' | 'unknown';
    orbitType?: OrbitType;
  }
): RadiationMeasurement[] {
  const lines = csvContent.trim().split('\n');
  const measurements: RadiationMeasurement[] = [];
  
  const startIndex = options.skipHeader ? 1 : 0;
  const columnMap = options.columnMap || {};
  
  // Parse header if available (for column mapping)
  let headerColumns: string[] | null = null;
  if (lines.length > 0) {
    if (options.skipHeader && lines.length > 1) {
      // Header is at index 0, data starts at index 1
      headerColumns = parseCSVLine(lines[0]);
    } else if (!options.skipHeader) {
      // First line might be header, try to use it
      headerColumns = parseCSVLine(lines[0]);
    }
  }
  
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const columns = parseCSVLine(line);
    
    try {
      // Map columns using columnMap or positional mapping
      const getColumn = (field: string, index: number): string | undefined => {
        // Check if field exists in columnMap
        if (field in columnMap && columnMap[field]) {
          const mappedColumnName = columnMap[field];
          // Find the index of the mapped column name in the CSV header
          if (headerColumns) {
            const mappedIndex = headerColumns.indexOf(mappedColumnName);
            if (mappedIndex >= 0 && mappedIndex < columns.length) {
              return columns[mappedIndex];
            }
          }
        }
        // Fall back to positional mapping
        return columns[index];
      };
      
      const timestamp = getColumn('timestamp', 0) ?? new Date().toISOString();
      const fluxStr = getColumn('particleFlux', 1);
      const flux = fluxStr ? parseFloat(fluxStr) : NaN;
      const altitudeStr = getColumn('altitude', 2);
      const altitudeRaw = altitudeStr ? parseFloat(altitudeStr) : NaN;
      const altitude = isNaN(altitudeRaw) ? 400 : altitudeRaw;
      const lShellStr = getColumn('L_shell', 3);
      const lShellRaw = lShellStr ? parseFloat(lShellStr) : NaN;
      const L_shell = isNaN(lShellRaw) ? 1.1 : lShellRaw;
      // Store column values first to avoid calling getColumn twice
      const latitudeStr = getColumn('latitude', 4);
      const longitudeStr = getColumn('longitude', 5);
      const latitude = latitudeStr ? parseFloat(latitudeStr) : undefined;
      const longitude = longitudeStr ? parseFloat(longitudeStr) : undefined;
      // Use nullish coalescing and NaN checks to distinguish between missing values and actual 0
      const energyMinStr = getColumn('energy_min', 6);
      const energyMaxStr = getColumn('energy_max', 7);
      const energyMinRaw = energyMinStr ? parseFloat(energyMinStr) : NaN;
      const energyMin = isNaN(energyMinRaw) ? 0.1 : energyMinRaw;
      const energyMaxRaw = energyMaxStr ? parseFloat(energyMaxStr) : NaN;
      const energyMax = isNaN(energyMaxRaw) ? 10 : energyMaxRaw; // Only use fallback if NaN (missing), not if 0
      const particleTypeStr = (getColumn('particleType', 8) ?? 'electron').toLowerCase();
      
      if (isNaN(flux) || flux < 0) continue;
      
      const particleType: ParticleType = 
        particleTypeStr.includes('proton') ? 'proton' :
        particleTypeStr.includes('electron') ? 'electron' :
        particleTypeStr.includes('alpha') ? 'alpha' :
        'electron';
      
      const orbitType: OrbitType = options.orbitType || 
        (altitude < 2000 ? 'LEO' : altitude < 35786 ? 'MEO' : 'GEO');
      
      const measurement: RadiationMeasurement = {
        timestamp: normalizeTimestamp(timestamp),
        particleFlux: flux,
        altitude,
        L_shell,
        latitude,
        longitude,
        particleType,
        energyRange: {
          min: energyMin,
          max: energyMax,
        },
        orbitType,
        source: options.source,
        metadata: {
          quality: 'medium',
        },
        ...options.defaults,
      };
      
      measurements.push(measurement);
    } catch (error) {
      console.warn(`Error parsing CSV line ${i + 1}:`, error);
      continue;
    }
  }
  
  return measurements;
}

/**
 * Load and parse CSV file from URL or File object
 */
export async function loadRadiationCSV(
  source: string | File,
  parser: 'erg-arase' | 'cses' | 'generic' = 'generic',
  options: CSVParserOptions & { source?: 'erg-arase' | 'cses' | 'unknown' } = {}
): Promise<RadiationMeasurement[]> {
  let csvContent: string;
  
  if (source instanceof File) {
    csvContent = await source.text();
  } else {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to load CSV: ${response.statusText}`);
    }
    csvContent = await response.text();
  }
  
  switch (parser) {
    case 'erg-arase':
      return parseERGAraseCSV(csvContent, options);
    case 'cses':
      return parseCSESCSV(csvContent, options);
    case 'generic':
      return parseGenericRadiationCSV(csvContent, {
        ...options,
        source: options.source || 'unknown',
      });
    default:
      throw new Error(`Unknown parser: ${parser}`);
  }
}

/**
 * Parse a CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

/**
 * Normalize timestamp to ISO 8601 format
 */
function normalizeTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      // Try common formats
      const formats = [
        /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/, // YYYY-MM-DD HH:MM:SS
        /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, // YYYYMMDDHHMMSS
      ];
      
      for (const format of formats) {
        const match = timestamp.match(format);
        if (match) {
          const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
          return new Date(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day),
            parseInt(hour),
            parseInt(minute),
            parseInt(second)
          ).toISOString();
        }
      }
      
      return new Date().toISOString(); // Fallback to current time
    }
    return date.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

