/**
 * WebGL-based radiation data overlay
 * Renders radiation measurements as glowing dots/contours on orbit rings
 * Uses instanced rendering for performance
 * 
 * Note: Client-side component - uses WebGL/Three.js
 */

'use client'; // Mark as client component (for Next.js compatibility, if migrated)

import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { RadiationDataPoint } from '@/lib/types/radiation';

interface RadiationDataOverlayProps {
  data: RadiationDataPoint[];
  orbitFilter: string[]; // ['LEO', 'MEO', 'GEO']
  visible: boolean;
  /** Callback when a data point is clicked */
  onPointClick?: (point: RadiationDataPoint, index: number) => void;
  /** Encoding mode: 'color' uses color to represent flux, 'size' uses particle size */
  encodingMode?: 'color' | 'size' | 'both';
}

const EARTH_RADIUS_KM = 6371;
const ORBIT_ALTITUDES = {
  LEO: 400,
  MEO: 20000,
  GEO: 35786,
};

/**
 * Convert flux value to color (blue = low, red = high)
 * Uses logarithmic scale for better visualization
 */
function fluxToColor(flux: number, minFlux: number, maxFlux: number): THREE.Color {
  // Normalize flux on logarithmic scale
  const logMin = Math.log10(Math.max(minFlux, 1e-10));
  const logMax = Math.log10(Math.max(maxFlux, 1e-10));
  const logFlux = Math.log10(Math.max(flux, 1e-10));
  
  // Handle case where all values are identical (avoid division by zero)
  let normalized: number;
  if (Math.abs(logMax - logMin) < 1e-10) {
    // All values are the same, use middle color (yellow)
    normalized = 0.5;
  } else {
    normalized = (logFlux - logMin) / (logMax - logMin);
  }
  const clamped = Math.max(0, Math.min(1, normalized));

  // Interpolate from blue (low) to red (high)
  const r = clamped;
  const g = clamped < 0.5 ? clamped * 2 : 1 - (clamped - 0.5) * 2;
  const b = 1 - clamped;

  return new THREE.Color(r, g, b);
}

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
  
  // If we have lat/lon, use them directly
  if (latitude !== undefined && longitude !== undefined) {
    const latRad = (latitude * Math.PI) / 180;
    const lonRad = (longitude * Math.PI) / 180;
    
    return new THREE.Vector3(
      radius * Math.cos(latRad) * Math.cos(lonRad),
      radius * Math.sin(latRad),
      radius * Math.cos(latRad) * Math.sin(lonRad)
    );
  }
  
  // Otherwise, distribute points around the orbit based on L-shell
  // This is a simplified distribution
  const angle = (L_shell * 60) % (Math.PI * 2); // Distribute based on L-shell
  const inclination = Math.PI / 4; // 45 degree inclination as default
  
  return new THREE.Vector3(
    radius * Math.cos(inclination) * Math.cos(angle),
    radius * Math.sin(inclination),
    radius * Math.cos(inclination) * Math.sin(angle)
  );
}

/**
 * Glowing dot shader material
 */
const createGlowMaterial = () => {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      glowIntensity: { value: 1.0 },
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
        
        // Create glowing effect
        float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
        alpha *= glowIntensity;
        
        // Add pulsing effect
        float pulse = sin(time * 2.0) * 0.1 + 0.9;
        alpha *= pulse;
        
        // Outer glow
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

export const RadiationDataOverlay = ({
  data,
  orbitFilter,
  visible,
  onPointClick,
  encodingMode = 'color',
}: RadiationDataOverlayProps) => {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const { camera } = useThree();
  const filteredDataRef = useRef<RadiationDataPoint[]>([]);
  const raycasterRef = useRef(new THREE.Raycaster());

  // Filter and process data
  const processedData = useMemo(() => {
    if (!data || data.length === 0) return null;

    // Filter by orbit type
    const filtered = data.filter((d) => orbitFilter.includes(d.orbitType));
    if (filtered.length === 0) return null;

    // Store filtered data for click detection
    filteredDataRef.current = filtered;

    // Calculate min/max flux for color normalization
    const fluxes = filtered.map((d) => d.flux);
    const minFlux = Math.min(...fluxes);
    const maxFlux = Math.max(...fluxes);

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
      
      // Handle case where all values are identical (avoid division by zero)
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
        sizes[i] = 0.02 + normalizedFlux * 0.12; // Larger range for size-only mode
      } else {
        sizes[i] = 0.02 + normalizedFlux * 0.08; // Standard size range
      }
    });

    return { positions, colors, sizes, count: filtered.length };
  }, [data, orbitFilter, encodingMode]);

  // Create geometry
  const geometry = useMemo(() => {
    if (!processedData) return null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(processedData.positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(processedData.colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(processedData.sizes, 1));

    return geom;
  }, [processedData]);

  // Create material
  const material = useMemo(() => createGlowMaterial(), []);

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
    
    // Get normalized device coordinates
    const rect = event.target.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    // Update raycaster
    raycasterRef.current.setFromCamera(mouse, camera);
    
    // Check intersection with points
    // Note: THREE.Points requires special handling for raycasting
    // We need to check distance to nearest point manually
    const intersects = raycasterRef.current.intersectObject(pointsRef.current);
    
    if (intersects.length > 0) {
      const intersect = intersects[0];
      
      // For THREE.Points, we need to find the closest point
      // The intersect gives us the position, we need to find which point it is
      if (intersect.point && geometry) {
        const positions = geometry.attributes.position.array as Float32Array;
        let minDistance = Infinity;
        let closestIndex = -1;
        
        // Find closest point within threshold
        const threshold = 0.1; // Adjust based on point size
        for (let i = 0; i < positions.length; i += 3) {
          const pointPos = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
          const distance = pointPos.distanceTo(intersect.point);
          
          if (distance < threshold && distance < minDistance) {
            minDistance = distance;
            closestIndex = i / 3;
          }
        }
        
        if (closestIndex >= 0 && closestIndex < filteredDataRef.current.length) {
          onPointClick(filteredDataRef.current[closestIndex], closestIndex);
        }
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

/**
 * Alternative: Contour-based visualization using instanced meshes
 * This provides better performance for large datasets
 */
export const RadiationDataContours = ({
  data,
  orbitFilter,
  visible,
}: RadiationDataOverlayProps) => {
  const groupRef = useRef<THREE.Group>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);

  const meshes = useMemo(() => {
    if (!data || data.length === 0) return [];

    const filtered = data.filter((d) => orbitFilter.includes(d.orbitType));
    if (filtered.length === 0) return [];

    const fluxes = filtered.map((d) => d.flux);
    const minFlux = Math.min(...fluxes);
    const maxFlux = Math.max(...fluxes);

    return filtered.map((point) => {
      const position = calculatePosition(
        point.altitude,
        point.latitude,
        point.longitude,
        point.L_shell
      );

      const color = fluxToColor(point.flux, minFlux, maxFlux);
      
      // Size based on flux (logarithmic scale)
      const logMin = Math.log10(Math.max(minFlux, 1e-10));
      const logMax = Math.log10(Math.max(maxFlux, 1e-10));
      const logFlux = Math.log10(Math.max(point.flux, 1e-10));
      
      // Handle case where all values are identical (avoid division by zero)
      let normalizedFlux: number;
      if (Math.abs(logMax - logMin) < 1e-10) {
        // All values are the same, use middle size
        normalizedFlux = 0.5;
      } else {
        normalizedFlux = (logFlux - logMin) / (logMax - logMin);
      }
      const size = 0.02 + normalizedFlux * 0.08;

      return {
        position,
        color,
        size,
      };
    });
  }, [data, orbitFilter]);

  if (!visible || meshes.length === 0) return null;

  return (
    <group ref={groupRef}>
      {meshes.map((mesh, i) => (
        <mesh key={i} position={[mesh.position.x, mesh.position.y, mesh.position.z]}>
          <sphereGeometry args={[mesh.size, 8, 8]} />
          <meshBasicMaterial
            color={mesh.color}
            transparent
            opacity={0.8}
            emissive={mesh.color}
            emissiveIntensity={0.5}
          />
        </mesh>
      ))}
    </group>
  );
};

