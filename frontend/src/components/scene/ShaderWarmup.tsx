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
 *
 * Then each program is "used" once, one per task: three reads back a program's
 * compile diagnostics on first use, and that read blocks even after the async
 * compile reports it ready (292 ms over 14 programs in the first frame, cold).
 *
 * Last, one frame is drawn while the canvas is still transparent, everything in
 * it, so the GPU builds its pipelines and uploads buffers before the scene is shown
 * (the first visible frames took 100-200 ms of GPU time on a cold visit).
 */
import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { makeTracerMaterial } from './Magnetosphere';
import { createGlowMaterial } from './RadiationDataOverlayLOD';

/** Don't hold the scene back forever if a driver never reports completion. */
const MAX_WAIT_MS = 20_000;

const nextTask = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Resolves once the GPU has finished everything submitted so far, polling a fence
 * (never blocking). Waiting a couple of frames isn't enough: ANGLE's Metal backend
 * builds pipelines when the GPU runs the first draw, after the JS call returns.
 */
async function gpuFinished(gl: THREE.WebGLRenderer, maxMs = 5000): Promise<void> {
  const ctx = gl.getContext();
  if (!(ctx instanceof WebGL2RenderingContext)) return wait(50);
  const sync = ctx.fenceSync(ctx.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return;
  ctx.flush();
  const start = performance.now();
  try {
    while (ctx.getSyncParameter(sync, ctx.SYNC_STATUS) !== ctx.SIGNALED && performance.now() - start < maxMs) {
      await wait(16);
    }
  } finally {
    ctx.deleteSync(sync);
  }
}

/**
 * Draw everything once out of sight, hidden objects and idle instanced geometry
 * included (the field-line pool has no instances until the first trace), so their
 * pipelines and buffers exist before they first appear, and wait for the GPU.
 */
async function drawHidden(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
  const shown: THREE.Object3D[] = [];
  const bumped: THREE.InstancedBufferGeometry[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      shown.push(o);
      o.visible = true;
    }
    const g = (o as THREE.Mesh).geometry;
    if (g instanceof THREE.InstancedBufferGeometry && g.instanceCount === 0) {
      bumped.push(g);
      g.instanceCount = 1;
    }
  });
  try {
    gl.render(scene, camera);
  } finally {
    for (const o of shown) o.visible = false;
    for (const g of bumped) g.instanceCount = 0;
  }
  await gpuFinished(gl);
}

/**
 * First use of every compiled program (diagnostics, uniform and attribute lookup),
 * one program per task so no single task is long.
 */
async function primePrograms(gl: THREE.WebGLRenderer, cancelled: () => boolean): Promise<void> {
  for (const program of gl.info.programs ?? []) {
    if (cancelled()) return;
    program.getUniforms();
    program.getAttributes();
    await nextTask();
  }
}

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
    compiled
      .catch(() => undefined)
      .then(() => primePrograms(gl, () => settled))
      .then(() => (settled ? undefined : drawHidden(gl, scene, camera)))
      .catch(() => undefined)
      .finally(finish);
    const timer = window.setTimeout(finish, MAX_WAIT_MS);
    return () => {
      settled = true;
      window.clearTimeout(timer);
    };
  }, [get]);

  return <primitive object={standIns} />;
}
