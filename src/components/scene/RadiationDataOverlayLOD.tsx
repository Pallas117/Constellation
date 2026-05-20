/**
 * WebGL-based radiation data overlay with Level-of-Detail (LOD) controls
 * Optimized for maintaining 60fps with large datasets
 * Uses instanced rendering and LOD-based culling
 * 
 * Note: Client-side component - uses WebGL/Three.js
 */

'use client'; // Mark as client component (for Next.js compatibility, if migrated)

import { useMemo, useRef, useState, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { RadiationDataPoint } from '@/lib/types/radiation';

interface RadiationDataOverlayLODProps {
  data: RadiationDataPoint[];
  orbitFilter: string[]; // ['LEO', 'MEO', 'GEO']
  visible: boolean;
  /** Callback when a data point is clicked */
  onPointClick?: (point: RadiationDataPoint, index: number) => void;
  /** LOD level: 0 = highest detail, 3 = lowest detail */
  lodLevel?: number;
  /** Maximum number of points to render (auto-calculated if not provided) */
  maxPoints?: number;
  /** Enable automatic LOD based on camera distance */
  autoLOD?: boolean;
  /** Encoding mode: 'color' uses color to represent flux, 'size' uses particle size */
  encodingMode?: 'color' | 'size' | 'both';
}

const EARTH_RADIUS_KM = 6371;

// LOD configurations: [maxPoints, pointSize, distanceThreshold]
const LOD_CONFIGS = [
  { maxPoints: Infinity, pointSize: 0.1, distanceThreshold: 0 }, // LOD 0: All points, full size
  { maxPoints: 50000, pointSize: 0.08, distanceThreshold: 5 }, // LOD 1: 50k points
  { maxPoints: 20000, pointSize: 0.06, distanceThreshold: 10 }, // LOD 2: 20k points
  { maxPoints: 5000, pointSize: 0.04, distanceThreshold: 15 }, // LOD 3: 5k points
];

/**
 * Calculate 3D position from orbital parameters
 */
function calculatePosition(
  altitude: number,
  latitude: number | undefined,
  longitude: number | undefined,
  L_shell: number
): THREE.Vector3 {
  const radius = 1 + altitude / EARTH_RADIUS_KM;
  
  if (latitude !== undefined && longitude !== undefined) {
    const latRad = (latitude * Math.PI) / 180;
    const lonRad = (longitude * Math.PI) / 180;
    
    return new THREE.Vector3(
      radius * Math.cos(latRad) * Math.cos(lonRad),
      radius * Math.sin(latRad),
      radius * Math.cos(latRad) * Math.sin(lonRad)
    );
  }
  
  const angle = (L_shell * 60) % (Math.PI * 2);
  const inclination = Math.PI / 4;
  
  return new THREE.Vector3(
    radius * Math.cos(inclination) * Math.cos(angle),
    radius * Math.sin(inclination),
    radius * Math.cos(inclination) * Math.sin(angle)
  );
}

/**
 * Convert flux value to color (blue = low, red = high)
 */
function fluxToColor(flux: number, minFlux: number, maxFlux: number): THREE.Color {
  const logMin = Math.log10(Math.max(minFlux, 1e-10));
  const logMax = Math.log10(Math.max(maxFlux, 1e-10));
  const logFlux = Math.log10(Math.max(flux, 1e-10));
  
  let normalized: number;
  if (Math.abs(logMax - logMin) < 1e-10) {
    normalized = 0.5;
  } else {
    normalized = (logFlux - logMin) / (logMax - logMin);
  }
  const clamped = Math.max(0, Math.min(1, normalized));

  const r = clamped;
  const g = clamped < 0.5 ? clamped * 2 : 1 - (clamped - 0.5) * 2;
  const b = 1 - clamped;

  return new THREE.Color(r, g, b);
}

/**
 * Downsample data based on LOD level
 */
function downsampleData(
  data: RadiationDataPoint[],
  maxPoints: number
): RadiationDataPoint[] {
  if (data.length <= maxPoints) return data;

  // Use uniform sampling for performance
  const step = Math.ceil(data.length / maxPoints);
  const sampled: RadiationDataPoint[] = [];

  for (let i = 0; i < data.length; i += step) {
    sampled.push(data[i]);
  }

  return sampled;
}

/**
 * Glowing dot shader material with LOD support
 */
const createGlowMaterial = (pointSize: number) => {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      glowIntensity: { value: 1.0 },
      pointSize: { value: pointSize },
    },
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      varying float vSize;
      
      void main() {
        vColor = color;
        vSize = size;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform float glowIntensity;
      varying vec3 vColor;
      varying float vSize;
      
      void main() {
        vec2 center = gl_PointCoord - vec2(0.5);
        float dist = length(center);
        
        float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
        alpha *= glowIntensity;
        
        float pulse = sin(time * 2.0) * 0.1 + 0.9;
        alpha *= pulse;
        
        float outerGlow = 1.0 - smoothstep(0.3, 0.7, dist);
        alpha += outerGlow * 0.3 * glowIntensity;
        
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true,
  });
};

export const RadiationDataOverlayLOD = ({
  data,
  orbitFilter,
  visible,
  onPointClick,
  lodLevel = 0,
  maxPoints,
  autoLOD = true,
  encodingMode = 'color',
}: RadiationDataOverlayLODProps) => {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const { camera } = useThree();
  const filteredDataRef = useRef<RadiationDataPoint[]>([]);
  const raycasterRef = useRef(new THREE.Raycaster());
  const [currentLOD, setCurrentLOD] = useState(lodLevel);

  // Calculate effective LOD based on camera distance
  useEffect(() => {
    if (!autoLOD || !pointsRef.current) return;

    const updateLOD = () => {
      if (!camera || !pointsRef.current) return;

      const cameraPosition = new THREE.Vector3();
      camera.getWorldPosition(cameraPosition);
      const distance = cameraPosition.length();

      // Determine LOD based on distance
      let newLOD = 0;
      for (let i = LOD_CONFIGS.length - 1; i >= 0; i--) {
        if (distance > LOD_CONFIGS[i].distanceThreshold) {
          newLOD = i;
          break;
        }
      }

      if (newLOD !== currentLOD) {
        setCurrentLOD(newLOD);
      }
    };

    const interval = setInterval(updateLOD, 100); // Check every 100ms
    return () => clearInterval(interval);
  }, [autoLOD, camera, currentLOD]);

  // Get LOD configuration
  const lodConfig = LOD_CONFIGS[Math.min(currentLOD, LOD_CONFIGS.length - 1)];
  const effectiveMaxPoints = maxPoints || lodConfig.maxPoints;

  // Filter and process data with LOD
  const processedData = useMemo(() => {
    if (!data || data.length === 0) return null;

    // Filter by orbit type
    let filtered = data.filter((d) => orbitFilter.includes(d.orbitType));
    if (filtered.length === 0) return null;

    // Apply LOD downsampling
    filtered = downsampleData(filtered, effectiveMaxPoints);
    filteredDataRef.current = filtered;

    // Calculate min/max flux for color normalization
    const minFlux = filtered.reduce((min, d) => Math.min(min, d.flux), Infinity);
    const maxFlux = filtered.reduce((max, d) => Math.max(max, d.flux), -Infinity);

    // Create positions, colors, and sizes
    const positions = new Float32Array(filtered.length * 3);
    const colors = new Float32Array(filtered.length * 3);
    const sizes = new Float32Array(filtered.length);

    filtered.forEach((point, i) => {
      const position = calculatePosition(
        point.altitude,
        point.latitude,
        point.longitude,
        point.L_shell
      );

      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;

      // Calculate normalized flux for encoding
      const logMin = Math.log10(Math.max(minFlux, 1e-10));
      const logMax = Math.log10(Math.max(maxFlux, 1e-10));
      const logFlux = Math.log10(Math.max(point.flux, 1e-10));
      
      let normalizedFlux: number;
      if (Math.abs(logMax - logMin) < 1e-10) {
        normalizedFlux = 0.5;
      } else {
        normalizedFlux = (logFlux - logMin) / (logMax - logMin);
      }

      // Color encoding (for colorblind accessibility, can be disabled)
      if (encodingMode === 'color' || encodingMode === 'both') {
        const color = fluxToColor(point.flux, minFlux, maxFlux);
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      } else {
        // Use neutral color when only size encoding
        colors[i * 3] = 0.5;
        colors[i * 3 + 1] = 0.7;
        colors[i * 3 + 2] = 1.0; // Light blue for visibility
      }

      // Size encoding (always used, but more prominent when color is disabled)
      if (encodingMode === 'size' || encodingMode === 'both') {
        sizes[i] = lodConfig.pointSize * (0.3 + normalizedFlux * 0.7); // Larger range for size-only mode
      } else {
        sizes[i] = lodConfig.pointSize * (0.5 + normalizedFlux * 0.5); // Standard size range
      }
    });

    return { positions, colors, sizes, count: filtered.length };
  }, [data, orbitFilter, effectiveMaxPoints, lodConfig.pointSize, encodingMode]);

  // Create geometry
  const geometry = useMemo(() => {
    if (!processedData) return null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(processedData.positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(processedData.colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(processedData.sizes, 1));

    return geom;
  }, [processedData]);

  // Create material with LOD-appropriate point size
  const material = useMemo(() => createGlowMaterial(lodConfig.pointSize), [lodConfig.pointSize]);

  // Animate glow
  useFrame((state) => {
    if (materialRef.current) {
      materialRef.current.uniforms.time.value = state.clock.elapsedTime;
    }
  });

  // Handle pointer events for click detection
  const handlePointerDown = (event: any) => {
    if (!onPointClick || !pointsRef.current || !geometry) return;

    event.stopPropagation();
    
    const rect = event.target.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    raycasterRef.current.setFromCamera(mouse, camera);
    const intersects = raycasterRef.current.intersectObject(pointsRef.current);
    
    if (intersects.length > 0 && intersects[0].point && geometry) {
      const positions = geometry.attributes.position.array as Float32Array;
      let minDistance = Infinity;
      let closestIndex = -1;
      
      const threshold = lodConfig.pointSize * 2;
      for (let i = 0; i < positions.length; i += 3) {
        const pointPos = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
        const distance = pointPos.distanceTo(intersects[0].point);
        
        if (distance < threshold && distance < minDistance) {
          minDistance = distance;
          closestIndex = i / 3;
        }
      }
      
      if (closestIndex >= 0 && closestIndex < filteredDataRef.current.length) {
        onPointClick(filteredDataRef.current[closestIndex], closestIndex);
      }
    }
  };

  if (!visible || !geometry || !processedData) return null;

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      onPointerDown={handlePointerDown}
    >
      <primitive
        object={material}
        ref={materialRef}
        attach="material"
      />
    </points>
  );
};

