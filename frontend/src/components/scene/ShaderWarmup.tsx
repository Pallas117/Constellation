/**
 * Compiles every shader before the first frame, without freezing the page.
 *
 * three.js compiles a material the first time it draws it, then blocks the main
 * thread until the GPU driver has finished. With a cold Metal shader cache (a
 * first visit) that froze the page for 3.4 s in one frame. compileAsync hands
 * the programs to the driver and polls KHR_parallel_shader_compile, so the page
 * stays responsive while it works; SpaceScene doesn't render until it's done.
 *
 * Materials that only appear later (field-line tracers after the first trace,
 * the storm radiation overlay) are compiled up front through hidden stand-ins
 * that stay in the scene, which keeps their programs cached for the real ones.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { makeTracerMaterial } from './Magnetosphere';
import { createGlowMaterial } from './RadiationDataOverlayLOD';

/** Don't hold the scene back forever if a driver never reports completion. */
const MAX_WAIT_MS = 20_000;

function pointsStandIn(material: THREE.Material): THREE.Points {
  const g = new THREE.BufferGeometry();
  // Same attributes as the real objects, so the program variant matches.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3), 3));
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(1), 1));
  return new THREE.Points(g, material);
}

export function ShaderWarmup({ onReady }: { onReady: () => void }) {
  const get = useThree((s) => s.get);
  const standIns = useMemo(() => {
    const group = new THREE.Group();
    group.visible = false;
    group.add(pointsStandIn(makeTracerMaterial()), pointsStandIn(createGlowMaterial(4)));
    return group;
  }, []);
  useEffect(
    () => () => {
      standIns.traverse((o) => {
        if (o instanceof THREE.Points) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    },
    [standIns],
  );

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const { gl, scene, camera } = get();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      onReadyRef.current();
    };
    // Compile hidden objects too (the stand-ins, the idle field-line slot): show
    // them for the synchronous part of compileAsync only. Nothing renders meanwhile.
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    let compiled: Promise<unknown>;
    try {
      compiled = gl.compileAsync(scene, camera);
    } catch {
      compiled = Promise.resolve();
    } finally {
      for (const o of hidden) o.visible = false;
    }
    compiled.catch(() => undefined).finally(finish);
    const timer = window.setTimeout(finish, MAX_WAIT_MS);
    return () => {
      settled = true;
      window.clearTimeout(timer);
    };
  }, [get]);

  return <primitive object={standIns} />;
}
