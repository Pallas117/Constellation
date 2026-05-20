/**
 * Orbit rings for LEO, MEO, and GEO
 * Rendered as wireframe circles at appropriate altitudes
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface OrbitRingsProps {
  visible: boolean;
  orbitFilter: string[]; // ['LEO', 'MEO', 'GEO']
}

// Orbit parameters (in Earth radii, where Earth radius = 1 unit)
const EARTH_RADIUS_KM = 6371;
const ORBIT_ALTITUDES = {
  LEO: 400, // km
  MEO: 20000, // km
  GEO: 35786, // km
};

export const OrbitRings = ({ visible, orbitFilter }: OrbitRingsProps) => {
  const leoRef = useRef<THREE.Line>(null);
  const meoRef = useRef<THREE.Line>(null);
  const geoRef = useRef<THREE.Line>(null);

  // Create orbit ring geometries
  const createOrbitGeometry = (radius: number, segments: number = 128) => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      points.push(
        new THREE.Vector3(
          Math.cos(angle) * radius,
          0,
          Math.sin(angle) * radius
        )
      );
    }
    return new THREE.BufferGeometry().setFromPoints(points);
  };

  const leoRadius = 1 + ORBIT_ALTITUDES.LEO / EARTH_RADIUS_KM;
  const meoRadius = 1 + ORBIT_ALTITUDES.MEO / EARTH_RADIUS_KM;
  const geoRadius = 1 + ORBIT_ALTITUDES.GEO / EARTH_RADIUS_KM;

  const leoGeometry = useMemo(() => createOrbitGeometry(leoRadius), [leoRadius]);
  const meoGeometry = useMemo(() => createOrbitGeometry(meoRadius), [meoRadius]);
  const geoGeometry = useMemo(() => createOrbitGeometry(geoRadius), [geoRadius]);

  // Orbit ring materials with subtle glow
  const orbitMaterial = useMemo(() => {
    return new THREE.LineBasicMaterial({
      color: '#4a90e2',
      transparent: true,
      opacity: 0.3,
      linewidth: 1,
    });
  }, []);

  const leoMaterial = useMemo(() => {
    return new THREE.LineBasicMaterial({
      color: '#60a5fa',
      transparent: true,
      opacity: orbitFilter.includes('LEO') ? 0.5 : 0.2,
      linewidth: 1,
    });
  }, [orbitFilter]);

  const meoMaterial = useMemo(() => {
    return new THREE.LineBasicMaterial({
      color: '#818cf8',
      transparent: true,
      opacity: orbitFilter.includes('MEO') ? 0.5 : 0.2,
      linewidth: 1,
    });
  }, [orbitFilter]);

  const geoMaterial = useMemo(() => {
    return new THREE.LineBasicMaterial({
      color: '#a78bfa',
      transparent: true,
      opacity: orbitFilter.includes('GEO') ? 0.5 : 0.2,
      linewidth: 1,
    });
  }, [orbitFilter]);

  // Subtle rotation animation - only animate rings that are in the filter
  useFrame((state) => {
    const time = state.clock.elapsedTime;
    // Only check refs for orbits that are actually in the filter
    if (orbitFilter.includes('LEO') && leoRef.current) {
      leoRef.current.rotation.y = time * 0.01;
    }
    if (orbitFilter.includes('MEO') && meoRef.current) {
      meoRef.current.rotation.y = time * 0.008;
    }
    if (orbitFilter.includes('GEO') && geoRef.current) {
      geoRef.current.rotation.y = time * 0.005;
    }
  });

  if (!visible) return null;

  // Create Line objects
  const leoLine = useMemo(() => {
    if (!orbitFilter.includes('LEO')) return null;
    return new THREE.Line(leoGeometry, leoMaterial);
  }, [leoGeometry, leoMaterial, orbitFilter]);

  const meoLine = useMemo(() => {
    if (!orbitFilter.includes('MEO')) return null;
    return new THREE.Line(meoGeometry, meoMaterial);
  }, [meoGeometry, meoMaterial, orbitFilter]);

  const geoLine = useMemo(() => {
    if (!orbitFilter.includes('GEO')) return null;
    return new THREE.Line(geoGeometry, geoMaterial);
  }, [geoGeometry, geoMaterial, orbitFilter]);

  return (
    <group>
      {/* LEO Ring */}
      {leoLine && (
        <primitive ref={leoRef} object={leoLine} />
      )}

      {/* MEO Ring */}
      {meoLine && (
        <primitive ref={meoRef} object={meoLine} />
      )}

      {/* GEO Ring */}
      {geoLine && (
        <primitive ref={geoRef} object={geoLine} />
      )}
    </group>
  );
};

