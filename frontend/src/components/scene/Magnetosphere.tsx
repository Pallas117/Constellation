import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  driversFromVisualParams,
  gsmToScene,
  magneticFootpoint,
  shueRadius,
  type SolarWindDrivers,
} from '@/lib/physics/geomagnetic';
import { CLOSED_NEAR, OPEN_NEAR, type FieldRenderData, type TracedModel } from '@/lib/physics/field-render';
import { damp } from '@/lib/physics/driver-smoothing';
import { fillRevolution, revolutionTopology } from '@/lib/physics/revolution';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useTracedMagnetosphere } from './useTracedMagnetosphere';
import { hoverHandlers, setSceneHover, type HoverTarget } from './scene-hover';

/** 1 = normal animation, 0 = frozen (prefers-reduced-motion). */
const MotionScale = createContext(1);
const useAnimTime = () => {
  const scale = useContext(MotionScale);
  return (elapsed: number) => elapsed * scale;
};
/** Time constant (s) for morphs and fades; 0 snaps under reduced motion. */
const useTau = (tau: number) => (useContext(MotionScale) === 0 ? 0 : tau);

const MORPH_TAU = 0.9; // boundaries settle in ~2-3 s
const FADE_TAU = 0.35; // field-line crossfade completes in ~1.2 s
const LINE_OPACITY = 0.6;
const LINE_WIDTH_PX = 1.1;

/** Deterministic per-index random in [0, 1): particles keep their identity across retraces. */
function seeded(i: number, salt = 0): number {
  let t = (i * 0x9e3779b1 + salt * 0x85ebca6b + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export interface MagnetosphereModelInfo {
  /** Drivers the shown geometry was traced from (5-min mean for live data). */
  drivers: SolarWindDrivers;
  smoothed: boolean;
  /** Null until the first field-line trace arrives. */
  tracedAt: number | null;
  r0: number;
  bowShock: number;
  tilt: number;
  oval: { equatorward: number; poleward: number };
  /** Null until the first field-line trace arrives. */
  openFraction: number | null;
}

interface MagnetosphereProps {
  visible: boolean;
  /** Legacy normalised drivers (0.6-1 compression, 0-1 reconnection). */
  compression: number;
  reconnectionStrength: number;
  /** Live solar wind drivers; override the values derived from the legacy params. */
  drivers?: Partial<SolarWindDrivers>;
  /** Epoch for the dipole tilt; defaults to now. */
  epochMs?: number;
  showSurfaces?: boolean;
  showFieldLines?: boolean;
  /** Average live drivers over 5 min before tracing (default). Turn off for simulations. */
  smoothing?: boolean;
  /** Called whenever a new field model is shown. */
  onModelUpdate?: (info: MagnetosphereModelInfo) => void;
  /** Report the boundary under the pointer (see scene-hover.ts). */
  hoverable?: boolean;
}

const TAIL_LENGTH = 40;

/** Props that make a mesh report itself to the HUD hover readout. */
const hoverProps = (target: HoverTarget, on: boolean) =>
  on ? { userData: { hoverTarget: target }, ...hoverHandlers } : {};

/* ------------------------------------------------------------------------- */
/* Field lines                                                               */
/* ------------------------------------------------------------------------- */

/** Segments each pooled line object can hold; the worst case seeds ~34k. */
const LINE_CAPACITY = 40_000;

/** A fat-line object with pre-allocated GPU buffers, filled in place on each retrace. */
function makeLineSlot(): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(new Float32Array(LINE_CAPACITY * 6));
  geometry.setColors(new Float32Array(LINE_CAPACITY * 6));
  geometry.instanceCount = 0;
  const material = new LineMaterial({
    vertexColors: true,
    linewidth: LINE_WIDTH_PX,
    worldUnits: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.toneMapped = false;
  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  lines.visible = false;
  return lines;
}

/** Copy a trace into a slot's existing buffers; uploads only the used range. */
function writeLineSlot(slot: LineSegments2, data: FieldRenderData) {
  const n = Math.min(data.segments.length / 6, LINE_CAPACITY);
  const write = (name: 'instanceStart' | 'instanceColorStart', src: Float32Array) => {
    const buffer = (slot.geometry.attributes[name] as THREE.InterleavedBufferAttribute).data;
    (buffer.array as Float32Array).set(src.subarray(0, n * 6));
    buffer.clearUpdateRanges();
    buffer.addUpdateRange(0, n * 6);
    buffer.needsUpdate = true;
  };
  write('instanceStart', data.segments);
  write('instanceColorStart', data.colors);
  slot.geometry.instanceCount = n;
}

/**
 * Field lines with a crossfade between traces, using two fat-line objects
 * allocated once. Creating a new object per retrace cost a 60-95 ms frame in
 * Chrome (fresh GPU buffers and material); filling pre-allocated buffers in
 * place avoids that entirely.
 */
const FieldLinePool = ({ data }: { data: FieldRenderData | null }) => {
  const tau = useTau(FADE_TAU);
  const size = useThree((st) => st.size);
  const gl = useThree((st) => st.gl);
  const camera = useThree((st) => st.camera);
  const scene = useThree((st) => st.scene);
  const slots = useMemo(() => [makeLineSlot(), makeLineSlot()], []);
  const active = useRef(-1);

  // Compile the fat-line shader while the worker traces the first field, so
  // the first frame that shows lines doesn't stall on shader compilation
  // (~190 ms measured in Chrome). Non-blocking where the driver supports
  // KHR_parallel_shader_compile; both slots share the compiled program.
  useEffect(() => {
    gl.compileAsync(slots[0], camera, scene).catch(() => undefined);
  }, [gl, camera, scene, slots]);

  useEffect(
    () => () => {
      for (const slot of slots) {
        slot.geometry.dispose();
        slot.material.dispose();
      }
    },
    [slots],
  );

  useLayoutEffect(() => {
    for (const slot of slots) slot.material.resolution.set(size.width, size.height);
  }, [slots, size.width, size.height]);

  // A new trace goes into the idle slot and fades in; the other fades out.
  useEffect(() => {
    if (!data) return;
    const next = active.current === 0 ? 1 : 0;
    writeLineSlot(slots[next], data);
    slots[next].material.opacity = 0;
    active.current = next;
  }, [data, slots]);

  useFrame((_, dt) => {
    slots.forEach((slot, i) => {
      const mat = slot.material;
      mat.opacity = damp(mat.opacity, i === active.current ? LINE_OPACITY : 0, dt, tau);
      slot.visible = mat.opacity > 0.002;
    });
  });

  return (
    <>
      <primitive object={slots[0]} />
      <primitive object={slots[1]} />
    </>
  );
};

/** Plasma tracers flowing along the traced field lines at constant arc speed. */
const FieldLineTracers = memo(function FieldLineTracers({ data, count = 520 }: { data: FieldRenderData; count?: number }) {
  const pointsRef = useRef<THREE.Points>(null);
  const animTime = useAnimTime();

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = 0.05 + seeded(i, 3) * 0.07;
    g.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    return g;
  }, [count]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Assign particles to lines in proportion to length so density is even in
  // space. Draws are seeded per particle, so after a retrace each particle
  // lands on the corresponding stretch of the new field instead of jumping.
  const assign = useMemo(() => {
    const lines = data.pathOpen.length;
    const length = new Float32Array(lines);
    let total = 0;
    for (let l = 0; l < lines; l++) {
      length[l] = data.pathCum[data.pathStart[l + 1] - 1] || 0;
      total += length[l];
    }
    const lineIdx = new Uint16Array(count);
    const phase = new Float32Array(count);
    const colors = geometry.attributes.color.array as Float32Array;
    for (let i = 0; i < count; i++) {
      let r = seeded(i, 1) * (total || 1);
      let k = 0;
      while (k < lines - 1 && r > length[k]) r -= length[k++];
      lineIdx[i] = k;
      phase[i] = seeded(i, 2);
      colors.set(data.pathOpen[k] ? OPEN_NEAR : CLOSED_NEAR, i * 3);
    }
    geometry.attributes.color.needsUpdate = true;
    return { lineIdx, phase, length };
  }, [data, count, geometry]);

  useFrame((state) => {
    const pts = pointsRef.current;
    if (!pts || assign.length.length === 0) return;
    const pos = geometry.attributes.position.array as Float32Array;
    const time = animTime(state.clock.elapsedTime);
    const { pathPoints, pathCum, pathStart, pathOpen } = data;
    for (let i = 0; i < count; i++) {
      const l = assign.lineIdx[i];
      const len = assign.length[l];
      if (!(len > 0)) continue;
      const speed = pathOpen[l] ? 2.2 : 1.2; // Re per second
      const s = ((assign.phase[i] * len + time * speed) % len + len) % len;
      // Binary search the segment within this line.
      let lo = pathStart[l];
      let hi = pathStart[l + 1] - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pathCum[mid] < s) lo = mid;
        else hi = mid;
      }
      const seg = pathCum[hi] - pathCum[lo] || 1;
      const f = (s - pathCum[lo]) / seg;
      pos[i * 3] = pathPoints[lo * 3] + (pathPoints[hi * 3] - pathPoints[lo * 3]) * f;
      pos[i * 3 + 1] = pathPoints[lo * 3 + 1] + (pathPoints[hi * 3 + 1] - pathPoints[lo * 3 + 1]) * f;
      pos[i * 3 + 2] = pathPoints[lo * 3 + 2] + (pathPoints[hi * 3 + 2] - pathPoints[lo * 3 + 2]) * f;
    }
    geometry.attributes.position.needsUpdate = true;
  });

  const material = useMemo(() => makeTracerMaterial(), []);
  useEffect(() => () => material.dispose(), [material]);

  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />;
});

/** Tracer particle material. Exported so the scene can compile it before the first trace. */
export function makeTracerMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GLOW_POINT_VERT,
    fragmentShader: GLOW_POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

const GLOW_POINT_VERT = /* glsl */ `
  attribute float size;
  attribute vec3 color;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (260.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const GLOW_POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = exp(-d * d * 40.0);
    float halo = exp(-d * d * 10.0) * 0.45;
    gl_FragColor = vec4(vColor * (core + halo), core + halo);
  }
`;

/* ------------------------------------------------------------------------- */
/* Boundaries                                                                */
/* ------------------------------------------------------------------------- */

const BOUNDARY_VERT = /* glsl */ `
  varying vec3 vPos;
  varying vec2 vUv;
  varying float vFresnel;
  void main() {
    vPos = position;
    vUv = uv;
    vec3 n = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFresnel = pow(1.0 - abs(dot(normalize(-mv.xyz), n)), 2.2);
    gl_Position = projectionMatrix * mv;
  }
`;

const MAGNETOPAUSE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uReconnection;
  uniform float uR0;
  uniform float uTail;
  uniform vec3 uColor;
  uniform vec3 uHot;
  varying vec3 vPos;
  varying vec2 vUv;
  varying float vFresnel;
  void main() {
    // Plasma flows anti-sunward along the boundary.
    float flow = 0.5 + 0.5 * sin(vPos.x * 0.9 + uTime * 1.6 + sin(vUv.x * 37.7) * 0.6);
    // Fine meridian/latitude lattice for depth cues.
    float lat = smoothstep(0.96, 1.0, abs(sin(vUv.y * 3.14159 * 18.0)));
    float lon = smoothstep(0.985, 1.0, abs(sin(vUv.x * 3.14159 * 12.0)));
    float lattice = max(lat, lon) * 0.35;
    // Dayside reconnection hot spot around the subsolar point.
    float sub = exp(-pow(length(vPos - vec3(uR0, 0.0, 0.0)) / (0.45 * uR0), 2.0));
    float tailFade = 1.0 - smoothstep(uTail * 0.45, uTail, -vPos.x);
    vec3 col = mix(uColor, uHot, clamp(sub * uReconnection * 1.4, 0.0, 1.0));
    float a = (vFresnel * (0.32 + 0.18 * flow) + lattice * vFresnel + sub * uReconnection * 0.35) * tailFade;
    gl_FragColor = vec4(col, clamp(a, 0.0, 0.7));
  }
`;

const BOWSHOCK_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uPressure;
  varying vec3 vPos;
  varying vec2 vUv;
  varying float vFresnel;
  void main() {
    float ripple = 0.5 + 0.5 * sin(vPos.x * 2.2 - uTime * 3.0 + sin(vUv.x * 25.0));
    float fade = 1.0 - smoothstep(-2.0, -14.0, vPos.x);
    // Warm white at nominal pressure, heating to Sun (#C2552A) under compression.
    vec3 col = mix(vec3(0.953, 0.941, 0.910), vec3(0.761, 0.333, 0.165), clamp(uPressure / 15.0, 0.0, 1.0));
    float a = vFresnel * (0.12 + 0.12 * ripple) * fade;
    gl_FragColor = vec4(col, a);
  }
`;

const MP_THETA = 72;
const MP_PHI = 64;

const Magnetopause = ({ r0, alpha, reconnection, hover }: { r0: number; alpha: number; reconnection: number; hover: boolean }) => {
  const animTime = useAnimTime();
  const tau = useTau(MORPH_TAU);
  const shape = useRef({ r0, alpha });
  const geometry = useMemo(() => {
    const g = revolutionTopology(MP_THETA, MP_PHI);
    fillRevolution(g, (th) => shueRadius(th, shape.current.r0, shape.current.alpha), TAIL_LENGTH, MP_THETA, MP_PHI);
    return g;
  }, []);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uReconnection: { value: 0 },
          uR0: { value: 10 },
          uTail: { value: TAIL_LENGTH },
          uColor: { value: new THREE.Color('#2378C4') },
          uHot: { value: new THREE.Color('#C2552A') },
        },
        vertexShader: BOUNDARY_VERT,
        fragmentShader: MAGNETOPAUSE_FRAG,
        transparent: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );
  useFrame(({ clock }, dt) => {
    const cur = shape.current;
    if (Math.abs(cur.r0 - r0) > 1e-4 || Math.abs(cur.alpha - alpha) > 1e-5) {
      cur.r0 = damp(cur.r0, r0, dt, tau);
      cur.alpha = damp(cur.alpha, alpha, dt, tau);
      fillRevolution(geometry, (th) => shueRadius(th, cur.r0, cur.alpha), TAIL_LENGTH, MP_THETA, MP_PHI);
    }
    material.uniforms.uTime.value = animTime(clock.elapsedTime);
    material.uniforms.uReconnection.value = damp(material.uniforms.uReconnection.value, reconnection, dt, tau);
    material.uniforms.uR0.value = cur.r0;
  });
  return <mesh geometry={geometry} material={material} {...hoverProps('magnetopause', hover)} />;
};

const BS_THETA = 48;
const BS_PHI = 56;
const BS_ECC = 0.81;
const bowShockRadius = (standoff: number) => (th: number) => (standoff * (1 + BS_ECC)) / (1 + BS_ECC * Math.cos(th));

const BowShock = ({ standoff, pdyn, hover }: { standoff: number; pdyn: number; hover: boolean }) => {
  const animTime = useAnimTime();
  const tau = useTau(MORPH_TAU);
  const shape = useRef(standoff);
  const geometry = useMemo(() => {
    const g = revolutionTopology(BS_THETA, BS_PHI);
    fillRevolution(g, bowShockRadius(shape.current), 16, BS_THETA, BS_PHI);
    return g;
  }, []);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uPressure: { value: 2 } },
        vertexShader: BOUNDARY_VERT,
        fragmentShader: BOWSHOCK_FRAG,
        transparent: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );
  useFrame(({ clock }, dt) => {
    if (Math.abs(shape.current - standoff) > 1e-4) {
      shape.current = damp(shape.current, standoff, dt, tau);
      fillRevolution(geometry, bowShockRadius(shape.current), 16, BS_THETA, BS_PHI);
    }
    material.uniforms.uTime.value = animTime(clock.elapsedTime);
    material.uniforms.uPressure.value = damp(material.uniforms.uPressure.value, pdyn, dt, tau);
  });
  return <mesh geometry={geometry} material={material} {...hoverProps('bowShock', hover)} />;
};

/* ------------------------------------------------------------------------- */
/* Tail current sheet, X-lines, solar wind                                   */
/* ------------------------------------------------------------------------- */

const CURRENT_SHEET_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uReconnection;
  uniform float uXLine;
  varying vec2 vUv;
  varying vec3 vPos;
  void main() {
    float across = 1.0 - abs(vUv.y - 0.5) * 2.0;
    across = pow(max(across, 0.0), 2.5);
    float along = smoothstep(-8.0, -14.0, vPos.x) * (1.0 - smoothstep(-28.0, -40.0, vPos.x));
    // Bursty bulk flows radiate both ways from the near-Earth X-line.
    float d = vPos.x - uXLine;
    float burst = 0.5 + 0.5 * sin(abs(d) * 1.1 - uTime * (2.0 + 3.0 * uReconnection));
    float xglow = exp(-d * d / 6.0) * uReconnection;
    vec3 col = mix(vec3(0.906, 0.694, 0.290), vec3(0.953, 0.941, 0.910), xglow); // amber → warm white
    float a = across * along * (0.10 + 0.22 * burst * (0.3 + uReconnection)) + across * xglow * 0.5;
    gl_FragColor = vec4(col, a);
  }
`;

const CurrentSheet = ({ tilt, reconnection, width, hover }: { tilt: number; reconnection: number; width: number; hover: boolean }) => {
  const animTime = useAnimTime();
  const tau = useTau(MORPH_TAU);
  const meshRef = useRef<THREE.Mesh>(null);
  const shape = useRef({ tilt, width });
  // Unit width; scaled per frame so a new width morphs instead of rebuilding.
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(TAIL_LENGTH - 6, 1, 48, 8);
    g.translate(-(TAIL_LENGTH + 6) / 2, 0, 0);
    return g;
  }, []);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uReconnection: { value: 0 }, uXLine: { value: -24 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec3 vPos;
          void main() {
            vUv = uv;
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: CURRENT_SHEET_FRAG,
        transparent: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );
  useFrame(({ clock }, dt) => {
    const s = shape.current;
    s.tilt = damp(s.tilt, tilt, dt, tau);
    s.width = damp(s.width, width, dt, tau);
    if (meshRef.current) {
      meshRef.current.position.y = 10 * Math.tan(s.tilt);
      meshRef.current.scale.y = s.width;
    }
    material.uniforms.uTime.value = animTime(clock.elapsedTime);
    const rec = damp(material.uniforms.uReconnection.value, reconnection, dt, tau);
    material.uniforms.uReconnection.value = rec;
    // Near-Earth X-line moves earthward under strong driving.
    material.uniforms.uXLine.value = -26 + 8 * rec;
  });
  // Plane lies in scene XZ (GSM XY); hinge it to the tilted neutral sheet.
  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 10 * Math.tan(shape.current.tilt), 0]}
      scale={[1, shape.current.width, 1]}
      {...hoverProps('currentSheet', hover)}
    />
  );
};

const SolarWind = ({ standoff, pdyn }: { standoff: number; pdyn: number }) => {
  const animTime = useAnimTime();
  const tau = useTau(MORPH_TAU);
  const ref = useRef<THREE.Points>(null);
  const shape = useRef({ standoff, pdyn });
  const count = 420;
  const data = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const lanes = new Float32Array(count * 2);
    const phase = new Float32Array(count);
    const sizes = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const rr = Math.sqrt(seeded(i, 11)) * 22;
      const a = seeded(i, 12) * Math.PI * 2;
      lanes[i * 2] = rr * Math.cos(a);
      lanes[i * 2 + 1] = rr * Math.sin(a);
      phase[i] = seeded(i, 13);
      sizes[i] = 0.035 + seeded(i, 14) * 0.04;
      colors.set([0.953, 0.88, 0.70], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    return { geometry, lanes, phase };
  }, []);

  useFrame(({ clock }, dt) => {
    if (!ref.current) return;
    const sh = shape.current;
    sh.standoff = damp(sh.standoff, standoff, dt, tau);
    sh.pdyn = damp(sh.pdyn, pdyn, dt, tau);
    const pos = ref.current.geometry.attributes.position.array as Float32Array;
    const t = animTime(clock.elapsedTime);
    const speed = 6 + Math.sqrt(Math.max(sh.pdyn, 0.1)) * 2; // Re/s, display speed
    const x0 = 34;
    const span = x0 + TAIL_LENGTH;
    for (let i = 0; i < count; i++) {
      const x = x0 - ((data.phase[i] * span + t * speed) % span);
      let y = data.lanes[i * 2];
      let z = data.lanes[i * 2 + 1];
      // Deflect around the obstacle: push radially outward from the axis
      // to stay outside a paraboloid just beyond the bow shock.
      const rho = Math.hypot(y, z) || 1e-3;
      const minRho = x < sh.standoff ? Math.sqrt(Math.max(0, 2 * sh.standoff * 1.1 * (sh.standoff - x))) : 0;
      if (rho < minRho) {
        const s = minRho / rho;
        y *= s;
        z *= s;
      }
      pos[i * 3] = x;
      pos[i * 3 + 1] = z;
      pos[i * 3 + 2] = -y;
    }
    ref.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={ref} geometry={data.geometry} frustumCulled={false}>
      <shaderMaterial
        vertexShader={GLOW_POINT_VERT}
        fragmentShader={GLOW_POINT_FRAG}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
};

/* ------------------------------------------------------------------------- */
/* Auroral ovals                                                             */
/* ------------------------------------------------------------------------- */

const AURORA_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uKp;
  varying vec2 vUv;
  varying float vNight;
  void main() {
    // vUv.y: 0 at equatorward edge, 1 at poleward edge.
    float band = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
    float curtain = 0.6 + 0.4 * sin(vUv.x * 160.0 + uTime * 1.3) * sin(vUv.x * 47.0 - uTime * 0.7);
    vec3 green = vec3(0.8, 1.0, 0.0);        // signal lime (557.7 nm green line)
    vec3 red = vec3(0.761, 0.333, 0.165);    // Sun (630 nm red line, storm-time)
    vec3 col = mix(green, red, smoothstep(0.55, 1.0, vUv.y) * clamp(uKp / 6.0, 0.0, 1.0));
    float a = band * curtain * (0.35 + 0.65 * vNight) * (0.35 + uKp / 9.0);
    gl_FragColor = vec4(col, a);
  }
`;

const OVAL_STEPS = 128;
const OVAL_ROWS = 6;

/** Write oval vertex positions in place for the given tilt and boundaries. */
function fillOvals(g: THREE.BufferGeometry, tilt: number, equatorward: number, poleward: number) {
  const attr = g.attributes.position as THREE.BufferAttribute;
  const pos = attr.array as Float32Array;
  let o = 0;
  for (const hemi of [1, -1]) {
    for (let i = 0; i <= OVAL_ROWS; i++) {
      const v = i / OVAL_ROWS;
      for (let j = 0; j <= OVAL_STEPS; j++) {
        const mlt = (j / OVAL_STEPS) * Math.PI * 2;
        // Oval is displaced toward midnight: higher latitude at noon.
        const eq = equatorward + 3 * Math.cos(mlt);
        const pol = poleward + 4 * Math.cos(mlt);
        const p = gsmToScene(magneticFootpoint(tilt, hemi * (eq + (pol - eq) * v), mlt, 1.03));
        pos[o++] = p[0];
        pos[o++] = p[1];
        pos[o++] = p[2];
      }
    }
  }
  attr.needsUpdate = true;
  g.computeBoundingSphere();
}

const AuroralOvals = ({ tilt, oval, kp }: { tilt: number; oval: TracedModel['oval']; kp: number }) => {
  const animTime = useAnimTime();
  const tau = useTau(MORPH_TAU);
  const shape = useRef({ tilt, eq: oval.equatorward, pol: oval.poleward });
  const geometry = useMemo(() => {
    const uvs: number[] = [];
    const night: number[] = [];
    const indices: number[] = [];
    let base = 0;
    for (let h = 0; h < 2; h++) {
      for (let i = 0; i <= OVAL_ROWS; i++) {
        for (let j = 0; j <= OVAL_STEPS; j++) {
          const mlt = (j / OVAL_STEPS) * Math.PI * 2;
          uvs.push(j / OVAL_STEPS, i / OVAL_ROWS);
          night.push(0.5 - 0.5 * Math.cos(mlt));
          if (i < OVAL_ROWS && j < OVAL_STEPS) {
            const a = base + i * (OVAL_STEPS + 1) + j;
            const b = a + OVAL_STEPS + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
          }
        }
      }
      base += (OVAL_ROWS + 1) * (OVAL_STEPS + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(base * 3), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('aNight', new THREE.Float32BufferAttribute(night, 1));
    g.setIndex(indices);
    const s = shape.current;
    fillOvals(g, s.tilt, s.eq, s.pol);
    return g;
  }, []);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uKp: { value: 2 } },
        vertexShader: /* glsl */ `
          attribute float aNight;
          varying vec2 vUv;
          varying float vNight;
          void main() {
            vUv = uv;
            vNight = aNight;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: AURORA_FRAG,
        transparent: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );
  useFrame(({ clock }, dt) => {
    const s = shape.current;
    if (Math.abs(s.tilt - tilt) > 1e-5 || Math.abs(s.eq - oval.equatorward) > 1e-3 || Math.abs(s.pol - oval.poleward) > 1e-3) {
      s.tilt = damp(s.tilt, tilt, dt, tau);
      s.eq = damp(s.eq, oval.equatorward, dt, tau);
      s.pol = damp(s.pol, oval.poleward, dt, tau);
      fillOvals(geometry, s.tilt, s.eq, s.pol);
    }
    material.uniforms.uTime.value = animTime(clock.elapsedTime);
    material.uniforms.uKp.value = damp(material.uniforms.uKp.value, kp, dt, tau);
  });
  return <mesh geometry={geometry} material={material} />;
};

/* ------------------------------------------------------------------------- */

export const Magnetosphere = ({
  visible,
  compression,
  reconnectionStrength,
  drivers,
  epochMs,
  showSurfaces = true,
  showFieldLines = true,
  smoothing = true,
  onModelUpdate,
  hoverable = false,
}: MagnetosphereProps) => {
  const resolved = useMemo<SolarWindDrivers>(() => {
    const legacy = driversFromVisualParams(compression, reconnectionStrength);
    const pick = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    return {
      bz: pick(drivers?.bz, legacy.bz),
      by: pick(drivers?.by, legacy.by),
      pdyn: pick(drivers?.pdyn, legacy.pdyn),
      kp: pick(drivers?.kp, legacy.kp),
    };
  }, [compression, reconnectionStrength, drivers?.bz, drivers?.by, drivers?.pdyn, drivers?.kp]);

  // Fall back to a fixed epoch per mount so tracing stays stable without a clock.
  const mountEpoch = useMemo(() => Date.now(), []);
  const model = useTracedMagnetosphere(resolved, epochMs ?? mountEpoch, { smooth: smoothing, tailLength: TAIL_LENGTH });
  const state = model.current;
  const reducedMotion = usePrefersReducedMotion();
  // Shape follows the traced (averaged) drivers so every part of the scene agrees.
  const reconnection = THREE.MathUtils.clamp(-model.drivers.bz / 15, 0, 1);

  const onModelUpdateRef = useRef(onModelUpdate);
  onModelUpdateRef.current = onModelUpdate;
  useEffect(() => {
    onModelUpdateRef.current?.({
      drivers: model.drivers,
      smoothed: smoothing,
      tracedAt: model.tracedAt,
      r0: state.r0,
      bowShock: state.bowShock,
      tilt: state.tilt,
      oval: state.oval,
      openFraction: state.openFraction,
    });
  }, [model.drivers, model.tracedAt, smoothing, state]);

  // A boundary hidden or unmounted under the pointer never fires pointerout.
  useEffect(() => () => setSceneHover(null), [visible, showSurfaces]);

  if (!visible) return null;

  const tailRadius = shueRadius(Math.PI * 0.75, state.r0, state.alpha) * Math.sin(Math.PI * 0.75);

  return (
    <MotionScale.Provider value={reducedMotion ? 0 : 1}>
      <group>
        {showSurfaces && (
          <>
            <BowShock standoff={state.bowShock} pdyn={model.drivers.pdyn} hover={hoverable} />
            <Magnetopause r0={state.r0} alpha={state.alpha} reconnection={reconnection} hover={hoverable} />
            <CurrentSheet tilt={state.tilt} reconnection={reconnection} width={tailRadius * 1.3} hover={hoverable} />
            <SolarWind standoff={state.bowShock} pdyn={model.drivers.pdyn} />
          </>
        )}
        {showFieldLines && (
          <>
            <FieldLinePool data={state.render} />
            {state.render && <FieldLineTracers data={state.render} />}
          </>
        )}
        <AuroralOvals tilt={state.tilt} oval={state.oval} kp={model.drivers.kp} />
      </group>
    </MotionScale.Provider>
  );
};
