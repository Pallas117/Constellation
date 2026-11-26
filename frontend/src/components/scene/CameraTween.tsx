/** Eases the camera and orbit target to a goal (GAU-229); with reduced motion it jumps. */
import { useEffect, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec } from './scene-views';

export interface CameraGoalRequest {
  position: Vec;
  target: Vec;
  /** Change to send the camera to the goal again. */
  request: number;
}

const DURATION_S = 1.8;
const ease = (t: number) => t * t * (3 - 2 * t);

export function CameraTween({ goal, controlsRef }: { goal?: CameraGoalRequest; controlsRef: RefObject<{ target: THREE.Vector3; update: () => void } | null> }) {
  const { camera } = useThree();
  const run = useRef<{ t: number; fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toPos: THREE.Vector3; toTarget: THREE.Vector3 } | null>(null);

  // The newest goal, kept in an effect (refs are not written during render). It is declared before the
  // effect below, so on a new request that effect already reads the new goal.
  const latest = useRef(goal);
  useEffect(() => {
    latest.current = goal;
  });
  const request = goal?.request;

  useEffect(() => {
    const goal = latest.current;
    if (!goal) {
      run.current = null;
      return;
    }
    const controls = controlsRef.current;
    const toPos = new THREE.Vector3(...goal.position);
    const toTarget = new THREE.Vector3(...goal.target);
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      camera.position.copy(toPos);
      controls?.target.copy(toTarget);
      camera.lookAt(toTarget);
      controls?.update();
      run.current = null;
      return;
    }
    run.current = {
      t: 0,
      fromPos: camera.position.clone(),
      fromTarget: controls ? controls.target.clone() : new THREE.Vector3(),
      toPos,
      toTarget,
    };
    // Only a new request starts a move, not a re-render with the same one.
  }, [request, camera, controlsRef]);

  useFrame((_, delta) => {
    const r = run.current;
    if (!r) return;
    r.t = Math.min(1, r.t + delta / DURATION_S);
    const k = ease(r.t);
    camera.position.lerpVectors(r.fromPos, r.toPos, k);
    const target = new THREE.Vector3().lerpVectors(r.fromTarget, r.toTarget, k);
    const controls = controlsRef.current;
    controls?.target.copy(target);
    camera.lookAt(target);
    controls?.update();
    if (r.t >= 1) run.current = null;
  });

  return null;
}
