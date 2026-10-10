import { createContext, useContext, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import {
  computeMagnetosphere,
  driversFromVisualParams,
  gsmToScene,
  magneticFootpoint,
  shueRadius,
  type FieldLine,
  type MagnetosphereState,
  type SolarWindDrivers,
} from '@/lib/physics/geomagnetic';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/** 1 = normal animation, 0 = frozen (prefers-reduced-motion). */
const MotionScale = createContext(1);
const useAnimTime = () => {
  const scale = useContext(MotionScale);
  return (elapsed: number) => elapsed * scale;
};

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
}

const TAIL_LENGTH = 40;

// Lightbound brand palette: closed flux warm white → Earth blue, open flux
// amber → Sun. Signal lime is reserved for the outer belt / aurora.
const CLOSED_NEAR = new THREE.Color('#F3F0E8');
const CLOSED_FAR = new THREE.Color('#2378C4');
const OPEN_NEAR = new THREE.Color('#E7B14A');
const OPEN_FAR = new THREE.Color('#C2552A');

const LOG_B_MIN = Math.log10(5);
const LOG_B_MAX = Math.log10(60000);

const quantise = (v: number, step: number) => Math.round(v / step) * step;

/** Recompute the traced model only when drivers change meaningfully. */
function useMagnetosphereState(drivers: SolarWindDrivers, epochMs: number): MagnetosphereState {
  const bz = quantise(drivers.bz, 0.5);
  const by = quantise(drivers.by, 0.5);
  const pdyn = quantise(drivers.pdyn, 0.25);
  const kp = quantise(drivers.kp, 1 / 3);
  const epoch = quantise(epochMs, 10 * 60_000);
  return useMemo(
    () => computeMagnetosphere({ bz, by, pdyn, kp }, epoch, { tailLength: TAIL_LENGTH }),
    [bz, by, pdyn, kp, epoch],
  );
}

/* ------------------------------------------------------------------------- */
/* Field lines                                                               */
/* ------------------------------------------------------------------------- */

const FieldLines = ({ lines }: { lines: FieldLine[] }) => {
  const { points, colors } = useMemo(() => {
    const points: [number, number, number][] = [];
    const colors: [number, number, number][] = [];
    const c = new THREE.Color();
    for (const line of lines) {
      const open = line.topology === 'open';
      const near = open ? OPEN_NEAR : CLOSED_NEAR;
      const far = open ? OPEN_FAR : CLOSED_FAR;
      const vertexColor = (i: number): [number, number, number] => {
        const t = THREE.MathUtils.clamp((Math.log10(line.strength[i]) - LOG_B_MIN) / (LOG_B_MAX - LOG_B_MIN), 0, 1);
        c.copy(far).lerp(near, Math.pow(t, 1.6));
        // Lines converge at the poles; dim them near the surface so the
        // additive blend doesn't saturate the inner magnetosphere.
        const [px, py, pz] = line.points[i];
        const r = Math.hypot(px, py, pz);
        const k = (0.3 + 0.5 * t) * (0.15 + 0.85 * THREE.MathUtils.smoothstep(r, 1.0, 2.4));
        return [c.r * k, c.g * k, c.b * k];
      };
      for (let i = 0; i < line.points.length - 1; i++) {
        points.push(gsmToScene(line.points[i]), gsmToScene(line.points[i + 1]));
        colors.push(vertexColor(i), vertexColor(i + 1));
      }
    }
    return { points, colors };
  }, [lines]);

  if (points.length === 0) return null;
  return (
    <Line
      points={points}
      vertexColors={colors}
      segments
      lineWidth={1.1}
      transparent
      opacity={0.6}
      depthWrite={false}
      blending={THREE.AdditiveBlending}
      toneMapped={false}
    />
  );
};

/** Plasma tracers flowing along the traced field lines at constant arc speed. */
const FieldLineTracers = ({ lines, count = 520 }: { lines: FieldLine[]; count?: number }) => {
  const pointsRef = useRef<THREE.Points>(null);
  const animTime = useAnimTime();

  const data = useMemo(() => {
    const paths = lines.map((l) => {
      const pts = l.points.map(gsmToScene);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]];
        cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
      }
      return { pts, cum, length: cum[cum.length - 1], open: l.topology === 'open' };
    });
    const total = paths.reduce((s, p) => s + p.length, 0) || 1;
    const lineIdx = new Uint16Array(count);
    const phase = new Float32Array(count);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Sample lines in proportion to length so density is even in space.
      let r = Math.random() * total;
      let k = 0;
      while (k < paths.length - 1 && r > paths[k].length) r -= paths[k++].length;
      lineIdx[i] = k;
      phase[i] = Math.random();
      const col = paths[k]?.open ? OPEN_NEAR : CLOSED_NEAR;
      colors.set([col.r, col.g, col.b], i * 3);
      sizes[i] = 0.05 + Math.random() * 0.07;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    return { paths, lineIdx, phase, geometry };
  }, [lines, count]);

  useFrame((state) => {
    const pts = pointsRef.current;
    if (!pts || data.paths.length === 0) return;
    const pos = pts.geometry.attributes.position.array as Float32Array;
    const time = animTime(state.clock.elapsedTime);
    for (let i = 0; i < count; i++) {
      const path = data.paths[data.lineIdx[i]];
      if (!path || path.length === 0) continue;
      const speed = path.open ? 2.2 : 1.2; // Re per second
      const s = ((data.phase[i] * path.length + time * speed) % path.length + path.length) % path.length;
      // Binary search the segment.
      let lo = 0;
      let hi = path.cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (path.cum[mid] < s) lo = mid;
        else hi = mid;
      }
      const seg = path.cum[hi] - path.cum[lo] || 1;
      const f = (s - path.cum[lo]) / seg;
      const a = path.pts[lo];
      const b = path.pts[hi];
      pos[i * 3] = a[0] + (b[0] - a[0]) * f;
      pos[i * 3 + 1] = a[1] + (b[1] - a[1]) * f;
      pos[i * 3 + 2] = a[2] + (b[2] - a[2]) * f;
    }
    pts.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points ref={pointsRef} geometry={data.geometry} frustumCulled={false}>
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

/** Surface of revolution about the Sun–Earth line from r(θ), cut at x = -tail. */
function revolutionGeometry(radius: (theta: number) => number, tail: number, thetaSteps = 72, phiSteps = 64) {
  // Find the θ at which the surface reaches x = -tail.
  let thetaMax = Math.PI / 2;
  for (let th = Math.PI / 2; th < Math.PI * 0.98; th += 0.005) {
    thetaMax = th;
    if (radius(th) * Math.cos(th) <= -tail) break;
  }
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= thetaSteps; i++) {
    const th = (i / thetaSteps) * thetaMax;
    const r = radius(th);
    for (let j = 0; j <= phiSteps; j++) {
      const ph = (j / phiSteps) * Math.PI * 2;
      vertices.push(r * Math.cos(th), r * Math.sin(th) * Math.sin(ph), r * Math.sin(th) * Math.cos(ph));
      uvs.push(j / phiSteps, i / thetaSteps);
      if (i < thetaSteps && j < phiSteps) {
        const a = i * (phiSteps + 1) + j;
        const b = a + phiSteps + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

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

const Magnetopause = ({ state, reconnection }: { state: MagnetosphereState; reconnection: number }) => {
  const animTime = useAnimTime();
  const geometry = useMemo(
    () => revolutionGeometry((th) => shueRadius(th, state.r0, state.alpha), TAIL_LENGTH),
    [state.r0, state.alpha],
  );
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
  useFrame(({ clock }) => {
    material.uniforms.uTime.value = animTime(clock.elapsedTime);
    material.uniforms.uReconnection.value = reconnection;
    material.uniforms.uR0.value = state.r0;
  });
  return <mesh geometry={geometry} material={material} />;
};

const BowShock = ({ state, pdyn }: { state: MagnetosphereState; pdyn: number }) => {
  const animTime = useAnimTime();
  const geometry = useMemo(() => {
    const ecc = 0.81;
    const semiLatus = state.bowShock * (1 + ecc);
    return revolutionGeometry((th) => semiLatus / (1 + ecc * Math.cos(th)), 16, 48, 56);
  }, [state.bowShock]);
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
  useFrame(({ clock }) => {
    material.uniforms.uTime.value = animTime(clock.elapsedTime);
    material.uniforms.uPressure.value = pdyn;
  });
  return <mesh geometry={geometry} material={material} />;
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

const CurrentSheet = ({ tilt, reconnection, width }: { tilt: number; reconnection: number; width: number }) => {
  const animTime = useAnimTime();
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(TAIL_LENGTH - 6, width, 48, 8);
    g.translate(-(TAIL_LENGTH + 6) / 2, 0, 0);
    return g;
  }, [width]);
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
  useFrame(({ clock }) => {
    material.uniforms.uTime.value = animTime(clock.elapsedTime);
    material.uniforms.uReconnection.value = reconnection;
    // Near-Earth X-line moves earthward under strong driving.
    material.uniforms.uXLine.value = -26 + 8 * reconnection;
  });
  // Plane lies in scene XZ (GSM XY); hinge it to the tilted neutral sheet.
  return <mesh geometry={geometry} material={material} rotation={[-Math.PI / 2, 0, 0]} position={[0, 10 * Math.tan(tilt), 0]} />;
};

const SolarWind = ({ standoff, pdyn }: { standoff: number; pdyn: number }) => {
  const animTime = useAnimTime();
  const ref = useRef<THREE.Points>(null);
  const count = 420;
  const data = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const lanes = new Float32Array(count * 2);
    const phase = new Float32Array(count);
    const sizes = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const rr = Math.sqrt(Math.random()) * 22;
      const a = Math.random() * Math.PI * 2;
      lanes[i * 2] = rr * Math.cos(a);
      lanes[i * 2 + 1] = rr * Math.sin(a);
      phase[i] = Math.random();
      sizes[i] = 0.035 + Math.random() * 0.04;
      colors.set([0.953, 0.88, 0.70], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    return { geometry, lanes, phase };
  }, []);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pos = ref.current.geometry.attributes.position.array as Float32Array;
    const t = animTime(clock.elapsedTime);
    const speed = 6 + Math.sqrt(Math.max(pdyn, 0.1)) * 2; // Re/s, display speed
    const x0 = 34;
    const span = x0 + TAIL_LENGTH;
    for (let i = 0; i < count; i++) {
      const x = x0 - ((data.phase[i] * span + t * speed) % span);
      let y = data.lanes[i * 2];
      let z = data.lanes[i * 2 + 1];
      // Deflect around the obstacle: push radially outward from the axis
      // to stay outside a paraboloid just beyond the bow shock.
      const rho = Math.hypot(y, z) || 1e-3;
      const minRho = x < standoff ? Math.sqrt(Math.max(0, 2 * standoff * 1.1 * (standoff - x))) : 0;
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

const AuroralOvals = ({ state, kp }: { state: MagnetosphereState; kp: number }) => {
  const animTime = useAnimTime();
  const geometry = useMemo(() => {
    const steps = 128;
    const rows = 6;
    const vertices: number[] = [];
    const uvs: number[] = [];
    const night: number[] = [];
    const indices: number[] = [];
    let base = 0;
    for (const hemi of [1, -1]) {
      for (let i = 0; i <= rows; i++) {
        const v = i / rows;
        for (let j = 0; j <= steps; j++) {
          const mlt = (j / steps) * Math.PI * 2;
          // Oval is displaced toward midnight: higher latitude at noon.
          const eq = state.oval.equatorward + 3 * Math.cos(mlt);
          const pol = state.oval.poleward + 4 * Math.cos(mlt);
          const lat = eq + (pol - eq) * v;
          const p = gsmToScene(magneticFootpoint(state.tilt, hemi * lat, mlt, 1.03));
          vertices.push(...p);
          uvs.push(j / steps, v);
          night.push(0.5 - 0.5 * Math.cos(mlt));
          if (i < rows && j < steps) {
            const a = base + i * (steps + 1) + j;
            const b = a + steps + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
          }
        }
      }
      base += (rows + 1) * (steps + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('aNight', new THREE.Float32BufferAttribute(night, 1));
    g.setIndex(indices);
    return g;
  }, [state.tilt, state.oval.equatorward, state.oval.poleward]);

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
  useFrame(({ clock }) => {
    material.uniforms.uTime.value = animTime(clock.elapsedTime);
    material.uniforms.uKp.value = kp;
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

  // Fall back to a fixed epoch per mount so the memo stays stable without a clock.
  const mountEpoch = useMemo(() => Date.now(), []);
  const state = useMagnetosphereState(resolved, epochMs ?? mountEpoch);
  const reducedMotion = usePrefersReducedMotion();
  const reconnection = THREE.MathUtils.clamp(-resolved.bz / 15, 0, 1);

  if (!visible) return null;

  const tailRadius = shueRadius(Math.PI * 0.75, state.r0, state.alpha) * Math.sin(Math.PI * 0.75);

  return (
    <MotionScale.Provider value={reducedMotion ? 0 : 1}>
    <group>
      {showSurfaces && (
        <>
          <BowShock state={state} pdyn={resolved.pdyn} />
          <Magnetopause state={state} reconnection={reconnection} />
          <CurrentSheet tilt={state.tilt} reconnection={reconnection} width={tailRadius * 1.3} />
          <SolarWind standoff={state.bowShock} pdyn={resolved.pdyn} />
        </>
      )}
      {showFieldLines && (
        <>
          <FieldLines lines={state.lines} />
          <FieldLineTracers lines={state.lines} />
        </>
      )}
      <AuroralOvals state={state} kp={resolved.kp} />
    </group>
    </MotionScale.Provider>
  );
};
