/**
 * Storm walkthrough layers (GAU-229): the South Atlantic Anomaly outline and a teaching
 * satellite. Both come from the replay data and plain orbit maths (lib/walkthrough, lib/physics/frames);
 * the satellite is an illustration drawn far larger than life, not a real spacecraft.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { gsmToScene } from '@/lib/physics/geomagnetic';
import { circularOrbitGei, geiToGsm, geoPointGsm, orbitPeriodMs, RE_KM, type CircularOrbit } from '@/lib/physics/frames';
import type { WalkthroughData } from '@/lib/walkthrough/storm-walkthrough';

export interface WalkthroughLayer {
  data: WalkthroughData;
  orbit: CircularOrbit;
  atMs: number;
  showSaa: boolean;
}

// Earth blue and amber from the brand tokens: the anomaly is a caution, the satellite is neutral.
const AMBER = '#E7B14A';
const WARM = '#F3F0E8';
const CHARCOAL = '#87938E';
/** The satellite is ~10 m; at scale it would be invisible, so it is drawn this many Earth radii long. */
const SAT_SIZE = 0.22;

function outlinePoints(outline: [number, number][], atMs: number, altKm: number): THREE.Vector3[] {
  const pts = [...outline, outline[0]].map(([lat, lon]) => new THREE.Vector3(...gsmToScene(geoPointGsm(lat, lon, altKm, atMs))));
  return pts;
}

export const WalkthroughOverlay = ({ data, orbit, atMs, showSaa }: WalkthroughLayer) => {
  const alt = data.saa.altKm;
  // The outline is fixed to the ground, so it turns with the Earth as the clock runs.
  const core = useMemo(() => outlinePoints(data.saa.core, atMs, alt), [data, atMs, alt]);
  const extended = useMemo(() => outlinePoints(data.saa.extended, atMs, alt), [data, atMs, alt]);

  const pos = useMemo(() => {
    const u = circularOrbitGei(orbit, atMs);
    const g = geiToGsm(u, atMs);
    const r = 1 + orbit.altKm / RE_KM;
    return new THREE.Vector3(...gsmToScene([g[0] * r, g[1] * r, g[2] * r]));
  }, [orbit, atMs]);

  // Trail: the last quarter orbit, so direction of travel reads at a glance.
  const trail = useMemo(() => {
    const period = orbitPeriodMs(orbit.altKm);
    const out: THREE.Vector3[] = [];
    for (let k = 0; k <= 24; k++) {
      const t = atMs - (period / 4) * (1 - k / 24);
      const r = 1 + orbit.altKm / RE_KM;
      // Past positions expressed in the current frame, so the trail stays on the orbit.
      const gNow = geiToGsm(circularOrbitGei(orbit, t), atMs);
      out.push(new THREE.Vector3(...gsmToScene([gNow[0] * r, gNow[1] * r, gNow[2] * r])));
    }
    return out;
  }, [orbit, atMs]);

  // Face the panels to the Sun (+x in the scene) and the body to Earth's centre.
  const quaternion = useMemo(() => {
    const up = pos.clone().normalize();
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), up.clone().negate(), new THREE.Vector3(1, 0, 0));
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [pos]);

  return (
    <group>
      {showSaa && (
        <>
          <Line points={extended} color={AMBER} lineWidth={1} transparent opacity={0.45} dashed dashSize={0.04} gapSize={0.03} />
          <Line points={core} color={AMBER} lineWidth={2} transparent opacity={0.95} />
        </>
      )}
      <Line points={trail} color={CHARCOAL} lineWidth={1} transparent opacity={0.7} />
      <group position={pos} quaternion={quaternion} scale={SAT_SIZE}>
        {/* Bus */}
        <mesh>
          <boxGeometry args={[0.6, 0.6, 0.9]} />
          <meshBasicMaterial color={WARM} />
        </mesh>
        {/* Two solar wings on a boom, turned toward the Sun */}
        <mesh position={[1.35, 0, 0]}>
          <boxGeometry args={[1.8, 0.04, 0.9]} />
          <meshBasicMaterial color="#2378C4" />
        </mesh>
        <mesh position={[-1.35, 0, 0]}>
          <boxGeometry args={[1.8, 0.04, 0.9]} />
          <meshBasicMaterial color="#2378C4" />
        </mesh>
        {/* Antenna dish on the Earth-facing side */}
        <mesh position={[0, 0, 0.6]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.25, 0.18, 24, 1, true]} />
          <meshBasicMaterial color={CHARCOAL} side={THREE.DoubleSide} />
        </mesh>
      </group>
    </group>
  );
};
