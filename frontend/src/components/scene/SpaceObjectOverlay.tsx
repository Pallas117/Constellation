/**
 * SpaceObjectOverlay — Renders known orbital assets and candidate untracked objects
 * as part of the magnetosphere visualization.
 */

'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import type { SpaceObjectCatalogEntry, SpaceObjectDetectionAlert } from '@/lib/types/space-object';

interface SpaceObjectOverlayProps {
  objects: SpaceObjectCatalogEntry[];
  alert?: SpaceObjectDetectionAlert | null;
  visible: boolean;
}

const EARTH_RADIUS_KM = 6371;

function orbitPositionFromObject(object: SpaceObjectCatalogEntry): THREE.Vector3 {
  const radius = 1 + object.altitude / EARTH_RADIUS_KM;
  const latitude = object.latitude ?? 0;
  const longitude = object.longitude ?? object.raan;

  const latRad = (latitude * Math.PI) / 180;
  const lonRad = (longitude * Math.PI) / 180;

  return new THREE.Vector3(
    radius * Math.cos(latRad) * Math.cos(lonRad),
    radius * Math.sin(latRad),
    radius * Math.cos(latRad) * Math.sin(lonRad)
  );
}

function getObjectColor(object: SpaceObjectCatalogEntry): string {
  if (object.category === 'unknown') return '#ff5c5c';
  if (object.category === 'rocket_body') return '#ffb86c';
  if (object.category === 'debris') return '#8f8f8f';
  return '#7ae7ff';
}

export const SpaceObjectOverlay = ({ objects, alert, visible }: SpaceObjectOverlayProps) => {
  const markers = useMemo(() => {
    if (!visible || objects.length === 0) return [];

    return objects.map((object) => ({
      position: orbitPositionFromObject(object),
      color: getObjectColor(object),
      radius: object.category === 'unknown' ? 0.045 : 0.02,
      id: object.id,
      name: object.name,
    }));
  }, [objects, visible]);

  if (!visible || markers.length === 0) return null;

  return (
    <group>
      {markers.map((marker) => (
        <mesh key={marker.id} position={[marker.position.x, marker.position.y, marker.position.z]}>
          <sphereGeometry args={[marker.radius, 12, 12]} />
          <meshStandardMaterial
            color={marker.color}
            transparent
            opacity={0.85}
            emissive={marker.color}
            emissiveIntensity={0.5}
          />
        </mesh>
      ))}
      {alert ? (
        <group position={[0.02, 0.02, 0.02]}>
          <mesh>
            <sphereGeometry args={[0.05, 8, 8]} />
            <meshBasicMaterial color="#ff5c5c" transparent opacity={0.3} />
          </mesh>
        </group>
      ) : null}
    </group>
  );
};
