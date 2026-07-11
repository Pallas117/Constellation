import { useMemo } from "react";
import * as THREE from "three";
import type { MMSReconVectorPoint } from "@/lib/types/space-weather";

interface MMSReconnectionVectorsProps {
  visible: boolean;
  vectors: MMSReconVectorPoint[];
  scale?: number;
}

function confidenceOpacity(confidence: "high" | "medium" | "low"): number {
  if (confidence === "high") return 0.9;
  if (confidence === "medium") return 0.6;
  return 0.35;
}

export function MMSReconnectionVectors({
  visible,
  vectors,
  scale = 1.8,
}: MMSReconnectionVectorsProps) {
  const latest = vectors.length > 0 ? vectors[vectors.length - 1] : null;

  const payload = useMemo(() => {
    if (!latest) return null;
    const base = latest.barycenterGsmRe;
    const conf = latest.quality.confidence;

    return {
      base: new THREE.Vector3(base.x, base.y, base.z),
      j: new THREE.Vector3(
        latest.currentDensity.x,
        latest.currentDensity.y,
        latest.currentDensity.z,
      )
        .normalize()
        .multiplyScalar(scale),
      n: new THREE.Vector3(latest.normal.x, latest.normal.y, latest.normal.z)
        .normalize()
        .multiplyScalar(scale * 0.8),
      l: new THREE.Vector3(latest.lmn.l.x, latest.lmn.l.y, latest.lmn.l.z)
        .normalize()
        .multiplyScalar(scale * 0.7),
      m: new THREE.Vector3(latest.lmn.m.x, latest.lmn.m.y, latest.lmn.m.z)
        .normalize()
        .multiplyScalar(scale * 0.7),
      opacity: confidenceOpacity(conf),
    };
  }, [latest, scale]);

  if (!visible || !payload) {
    return null;
  }

  return (
    <group name="mms-reconnection-vectors">
      <mesh position={payload.base}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial color="#f8fafc" transparent opacity={payload.opacity} />
      </mesh>

      <arrowHelper args={[payload.j.clone().normalize(), payload.base, payload.j.length(), "#ef4444", 0.35, 0.18]} />
      <arrowHelper args={[payload.n.clone().normalize(), payload.base, payload.n.length(), "#22d3ee", 0.25, 0.14]} />
      <arrowHelper args={[payload.l.clone().normalize(), payload.base, payload.l.length(), "#60a5fa", 0.22, 0.12]} />
      <arrowHelper args={[payload.m.clone().normalize(), payload.base, payload.m.length(), "#34d399", 0.22, 0.12]} />
    </group>
  );
}
