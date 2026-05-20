import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// TYPES & SCHEMAS
// ============================================================================

interface SpaceWeatherData {
  timestamp: string;
  solarWind: {
    speed: number;
    density: number;
    pressure: number;
  };
  imf: {
    bz: number;
    bt: number;
  };
  particles: {
    protonFlux: number;
    electronFlux: number;
  };
  indices: {
    kp: number;
    dst: number;
  };
  flags: {
    stale: boolean;
    source: 'live' | 'cache' | 'fallback';
    lastUpdate: string;
  };
}

// In-memory cache
let dataCache: SpaceWeatherData | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Rolling average for baseline (used in fallback)
const rollingAverage = {
  solarWindSpeed: 400,
  solarWindDensity: 5,
  imfBz: 0,
  kp: 3,
  protonFlux: 1,
  electronFlux: 2000,
};

// ============================================================================
// DATA FETCHERS
// ============================================================================

async function fetchNOAASolarWind(): Promise<{ speed: number; density: number } | null> {
  try {
    // NOAA DSCOVR Plasma data
    const response = await fetch(
      'https://services.swpc.noaa.gov/products/solar-wind/plasma-1-day.json',
      { signal: AbortSignal.timeout(5000) }
    );
    
    if (!response.ok) throw new Error(`NOAA plasma API returned ${response.status}`);
    
    const data = await response.json();
    if (!Array.isArray(data) || data.length < 2) return null;
    
    // Get latest valid reading (skip header row)
    for (let i = data.length - 1; i > 0; i--) {
      const row = data[i];
      const speed = parseFloat(row[2]);
      const density = parseFloat(row[1]);
      
      if (!isNaN(speed) && !isNaN(density) && speed > 0 && density >= 0) {
        // Validate ranges
        if (speed > 200 && speed < 1500 && density < 100) {
          return { speed, density };
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('[NOAA Plasma] Fetch error:', error);
    return null;
  }
}

async function fetchNOAAMagneticField(): Promise<{ bz: number; bt: number } | null> {
  try {
    // NOAA DSCOVR Magnetic field data
    const response = await fetch(
      'https://services.swpc.noaa.gov/products/solar-wind/mag-1-day.json',
      { signal: AbortSignal.timeout(5000) }
    );
    
    if (!response.ok) throw new Error(`NOAA mag API returned ${response.status}`);
    
    const data = await response.json();
    if (!Array.isArray(data) || data.length < 2) return null;
    
    // Get latest valid reading
    for (let i = data.length - 1; i > 0; i--) {
      const row = data[i];
      const bz = parseFloat(row[3]); // Bz GSM
      const bt = parseFloat(row[6]); // Bt
      
      if (!isNaN(bz) && !isNaN(bt)) {
        // Validate ranges (extreme values would be -50 to +50 nT)
        if (Math.abs(bz) < 100 && bt >= 0 && bt < 100) {
          return { bz, bt };
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('[NOAA Mag] Fetch error:', error);
    return null;
  }
}

async function fetchNOAAKpIndex(): Promise<number | null> {
  try {
    // NOAA planetary K-index
    const response = await fetch(
      'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
      { signal: AbortSignal.timeout(5000) }
    );
    
    if (!response.ok) throw new Error(`NOAA Kp API returned ${response.status}`);
    
    const data = await response.json();
    if (!Array.isArray(data) || data.length < 2) return null;
    
    // Get latest Kp value
    const latestRow = data[data.length - 1];
    const kp = parseFloat(latestRow[1]);
    
    if (!isNaN(kp) && kp >= 0 && kp <= 9) {
      return kp;
    }
    
    return null;
  } catch (error) {
    console.error('[NOAA Kp] Fetch error:', error);
    return null;
  }
}

async function fetchNOAAProtonFlux(): Promise<number | null> {
  try {
    // NOAA GOES proton flux
    const response = await fetch(
      'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json',
      { signal: AbortSignal.timeout(5000) }
    );
    
    if (!response.ok) throw new Error(`NOAA proton API returned ${response.status}`);
    
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    
    // Get latest >10 MeV proton flux
    const latest = data[data.length - 1];
    const flux = latest.flux;
    
    if (typeof flux === 'number' && flux >= 0 && flux < 10000) {
      return flux;
    }
    
    return null;
  } catch (error) {
    console.error('[NOAA Proton] Fetch error:', error);
    return null;
  }
}

async function fetchNOAAElectronFlux(): Promise<number | null> {
  try {
    // NOAA GOES electron flux
    const response = await fetch(
      'https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-1-day.json',
      { signal: AbortSignal.timeout(5000) }
    );
    
    if (!response.ok) throw new Error(`NOAA electron API returned ${response.status}`);
    
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    
    // Get latest >2 MeV electron flux
    const latest = data[data.length - 1];
    const flux = latest.flux;
    
    if (typeof flux === 'number' && flux >= 0 && flux < 1e8) {
      return flux;
    }
    
    return null;
  } catch (error) {
    console.error('[NOAA Electron] Fetch error:', error);
    return null;
  }
}

// ============================================================================
// SPIKE REJECTION (±4σ filter)
// ============================================================================

function rejectSpike(value: number, baseline: number, maxDeviation: number): number {
  const deviation = Math.abs(value - baseline);
  if (deviation > maxDeviation * 4) {
    console.log(`[Spike Filter] Rejected value ${value}, using baseline ${baseline}`);
    return baseline;
  }
  return value;
}

// ============================================================================
// UPDATE ROLLING AVERAGE
// ============================================================================

function updateRollingAverage(data: SpaceWeatherData) {
  const alpha = 0.1; // Smoothing factor
  
  rollingAverage.solarWindSpeed = 
    alpha * data.solarWind.speed + (1 - alpha) * rollingAverage.solarWindSpeed;
  rollingAverage.solarWindDensity = 
    alpha * data.solarWind.density + (1 - alpha) * rollingAverage.solarWindDensity;
  rollingAverage.imfBz = 
    alpha * data.imf.bz + (1 - alpha) * rollingAverage.imfBz;
  rollingAverage.kp = 
    alpha * data.indices.kp + (1 - alpha) * rollingAverage.kp;
  rollingAverage.protonFlux = 
    alpha * data.particles.protonFlux + (1 - alpha) * rollingAverage.protonFlux;
  rollingAverage.electronFlux = 
    alpha * data.particles.electronFlux + (1 - alpha) * rollingAverage.electronFlux;
}

// ============================================================================
// MAIN DATA FETCH
// ============================================================================

async function fetchAllData(): Promise<SpaceWeatherData> {
  const now = Date.now();
  
  // Check cache
  if (dataCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    console.log('[Cache] Returning fresh cached data');
    return { ...dataCache, flags: { ...dataCache.flags, source: 'cache' } };
  }
  
  console.log('[Fetch] Fetching fresh data from NOAA APIs...');
  
  // Parallel fetch all data sources
  const [solarWind, magField, kp, protonFlux, electronFlux] = await Promise.all([
    fetchNOAASolarWind(),
    fetchNOAAMagneticField(),
    fetchNOAAKpIndex(),
    fetchNOAAProtonFlux(),
    fetchNOAAElectronFlux(),
  ]);
  
  // Check if we got any live data
  const hasLiveData = solarWind || magField || kp !== null || protonFlux !== null || electronFlux !== null;
  
  // Calculate dynamic pressure: P = 1.67e-6 * n * v^2 (nPa)
  const speed = solarWind?.speed ?? rollingAverage.solarWindSpeed;
  const density = solarWind?.density ?? rollingAverage.solarWindDensity;
  const pressure = 1.67e-6 * density * speed * speed;
  
  // Build response with spike rejection
  const data: SpaceWeatherData = {
    timestamp: new Date().toISOString(),
    solarWind: {
      speed: rejectSpike(speed, rollingAverage.solarWindSpeed, 200),
      density: rejectSpike(density, rollingAverage.solarWindDensity, 10),
      pressure: Math.min(pressure, 50), // Cap extreme values
    },
    imf: {
      bz: rejectSpike(magField?.bz ?? rollingAverage.imfBz, rollingAverage.imfBz, 15),
      bt: magField?.bt ?? Math.abs(rollingAverage.imfBz) + 2,
    },
    particles: {
      protonFlux: rejectSpike(protonFlux ?? rollingAverage.protonFlux, rollingAverage.protonFlux, 50),
      electronFlux: rejectSpike(electronFlux ?? rollingAverage.electronFlux, rollingAverage.electronFlux, 10000),
    },
    indices: {
      kp: Math.min(9, Math.max(0, kp ?? rollingAverage.kp)),
      dst: -10 - (kp ?? 3) * 5, // Estimated from Kp
    },
    flags: {
      stale: !hasLiveData || (dataCache !== null && (now - cacheTimestamp) > STALE_THRESHOLD_MS),
      source: hasLiveData ? 'live' : (dataCache ? 'cache' : 'fallback'),
      lastUpdate: new Date().toISOString(),
    },
  };
  
  // Update cache and rolling average
  if (hasLiveData) {
    dataCache = data;
    cacheTimestamp = now;
    updateRollingAverage(data);
    console.log('[Cache] Updated with fresh data');
  } else if (dataCache) {
    // Return stale cache if no live data
    console.log('[Cache] Returning stale cached data');
    return { 
      ...dataCache, 
      timestamp: new Date().toISOString(),
      flags: { ...dataCache.flags, stale: true, source: 'cache' } 
    };
  }
  
  return data;
}

// ============================================================================
// EDGE FUNCTION HANDLER
// ============================================================================

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    
    // Only allow GET requests
    if (req.method !== 'GET') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[Request] ${req.method} ${url.pathname}`);
    
    const data = await fetchAllData();
    
    return new Response(
      JSON.stringify(data),
      { 
        status: 200, 
        headers: { 
          ...corsHeaders, 
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60', // Client-side cache hint
        } 
      }
    );
    
  } catch (error) {
    console.error('[Error]', error);
    
    // Return fallback data on error
    const fallbackData: SpaceWeatherData = {
      timestamp: new Date().toISOString(),
      solarWind: {
        speed: rollingAverage.solarWindSpeed,
        density: rollingAverage.solarWindDensity,
        pressure: 1.67e-6 * rollingAverage.solarWindDensity * rollingAverage.solarWindSpeed ** 2,
      },
      imf: {
        bz: rollingAverage.imfBz,
        bt: Math.abs(rollingAverage.imfBz) + 2,
      },
      particles: {
        protonFlux: rollingAverage.protonFlux,
        electronFlux: rollingAverage.electronFlux,
      },
      indices: {
        kp: rollingAverage.kp,
        dst: -10 - rollingAverage.kp * 5,
      },
      flags: {
        stale: true,
        source: 'fallback',
        lastUpdate: new Date().toISOString(),
      },
    };
    
    return new Response(
      JSON.stringify(fallbackData),
      { 
        status: 200, // Still return 200 with fallback data
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
