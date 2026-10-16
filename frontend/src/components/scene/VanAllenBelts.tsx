import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  beltParticles,
  beltShells,
  DAYSIDE_SQUEEZE,
  ELECTRON_BELT,
  ELECTRON_PARTICLES,
  PARTICLE_PERIOD_S,
  PROTON_BELT,
  PROTON_PARTICLES,
  type BeltSpec,
  type ParticleSpec,
} from '@/lib/physics/belts';

interface VanAllenBeltsProps {
  visible: boolean;
  intensity: number;
  compression?: number;
  highFidelity?: boolean;
}

interface BeltLook {
  /** Brand colour at quiet times, and what it heats to in a storm (sRGB, written as-is). */
  base: [number, number, number];
  hot: [number, number, number];
  opacity: number;
  /** Gradient-curvature drift: protons drift west (-1), electrons east (+1). */
  drift: number;
}

// Shells are the faint ambient glow; the particles carry the colour.
const PROTONS: BeltLook = { base: [0.906, 0.694, 0.29], hot: [0.761, 0.333, 0.165], opacity: 0.08, drift: -1 }; // #E7B14A → #C2552A
const ELECTRONS: BeltLook = { base: [0.8, 1.0, 0.0], hot: [0.92, 1.0, 0.45], opacity: 0.025, drift: 1 }; // #CCFF00, whitening
/** Shell drift pattern speed: whole turns per PARTICLE_PERIOD_S so the wrapped clock never jumps. */
const SHELL_DRIFT = ((Math.PI * 2) * 38) / PARTICLE_PERIOD_S;

function shellGeometry(spec: BeltSpec, highFidelity: boolean, compression: number): THREE.BufferGeometry {
  const mesh = beltShells(spec, highFidelity ? 128 : 48, highFidelity ? 64 : 24, compression);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('aWeight', new THREE.BufferAttribute(mesh.weights, 1));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function beltMaterial(look: BeltLook): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0.8 },
      uOpacity: { value: look.opacity },
      uDrift: { value: look.drift },
      uBase: { value: new THREE.Vector3(...look.base) },
      uHot: { value: new THREE.Vector3(...look.hot) },
    },
    vertexShader: `
      attribute float aWeight;
      varying float vWeight;
      varying float vLon;
      varying vec3 vNormalV;
      varying vec3 vViewV;
      void main() {
        vWeight = aWeight;
        vLon = atan(-position.z, position.x); // east-positive longitude (x sunward, y north)
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewV = -mv.xyz;
        vNormalV = normalMatrix * normal;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uIntensity;
      uniform float uOpacity;
      uniform float uDrift;
      uniform vec3 uBase;
      uniform vec3 uHot;
      varying float vWeight;
      varying float vLon;
      varying vec3 vNormalV;
      varying vec3 vViewV;
      void main() {
        // Optically thin glow: brightness follows the path length through each shell.
        float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
        float path = min(1.0 / max(facing, 0.3), 3.0) / 3.0;
        // Slow azimuthal drift, opposite for protons and electrons.
        float drift = 0.88 + 0.12 * sin(vLon * 5.0 - uDrift * uTime * ${SHELL_DRIFT.toFixed(6)});
        vec3 color = mix(uBase, uHot, smoothstep(0.85, 1.0, uIntensity));
        float alpha = vWeight * path * drift * uOpacity * (0.6 + 0.4 * uIntensity);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function particleGeometry(spec: BeltSpec, motion: ParticleSpec, count: number, seed: number): THREE.BufferGeometry {
  const p = beltParticles(spec, motion, count, seed);
  const geometry = new THREE.BufferGeometry();
  // Positions are computed in the shader; this only sets the draw count.
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aL', new THREE.BufferAttribute(p.l, 1));
  geometry.setAttribute('aMirror', new THREE.BufferAttribute(p.mirror, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(p.phase, 1));
  geometry.setAttribute('aLon', new THREE.BufferAttribute(p.lon, 1));
  geometry.setAttribute('aBounce', new THREE.BufferAttribute(p.bounceRate, 1));
  geometry.setAttribute('aDrift', new THREE.BufferAttribute(p.driftRate, 1));
  return geometry;
}

/** Trapped particles bouncing between mirror points and drifting in longitude (lib/physics/belts particlePosition, on the GPU). */
function particleMaterial(color: [number, number, number], opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSqueeze: { value: 0 },
      uScale: { value: 450 },
      uOpacity: { value: opacity },
      uColor: { value: new THREE.Vector3(...color) },
    },
    vertexShader: `
      attribute float aL;
      attribute float aMirror;
      attribute float aPhase;
      attribute float aLon;
      attribute float aBounce;
      attribute float aDrift;
      uniform float uTime;
      uniform float uSqueeze;
      uniform float uScale;
      void main() {
        float lambda = aMirror * sin(aPhase + aBounce * uTime);
        float lon = aLon + aDrift * uTime;
        float c = cos(lambda);
        float r = aL * c * c * (1.0 - uSqueeze * (aL / 6.0) * cos(lon));
        vec4 mv = modelViewMatrix * vec4(r * c * cos(lon), r * sin(lambda), -r * c * sin(lon), 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(0.1 * uScale / -mv.z, 2.0, 6.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(uColor, smoothstep(0.5, 0.1, d) * uOpacity);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

/**
 * Van Allen belts: nested dipole L-shells weighted by trapped-particle density
 * (see lib/physics/belts) as a faint glow, with the trapped particles on top:
 * amber protons inside drifting west, lime electrons outside drifting east (the Gauss mark).
 */
export const VanAllenBelts = ({ visible, intensity, compression = 1, highFidelity = false }: VanAllenBeltsProps) => {
  // Compression follows the live pressure; rebuild only for visible changes.
  const squeeze = Math.round(compression * 100) / 100;
  const protonGeometry = useMemo(() => shellGeometry(PROTON_BELT, highFidelity, squeeze), [highFidelity, squeeze]);
  const electronGeometry = useMemo(() => shellGeometry(ELECTRON_BELT, highFidelity, squeeze), [highFidelity, squeeze]);
  useEffect(() => () => protonGeometry.dispose(), [protonGeometry]);
  useEffect(() => () => electronGeometry.dispose(), [electronGeometry]);

  const protonCount = highFidelity ? 1800 : 900;
  const electronCount = highFidelity ? 3600 : 1800;
  const protonDots = useMemo(() => particleGeometry(PROTON_BELT, PROTON_PARTICLES, protonCount, 11), [protonCount]);
  const electronDots = useMemo(() => particleGeometry(ELECTRON_BELT, ELECTRON_PARTICLES, electronCount, 23), [electronCount]);
  useEffect(() => () => protonDots.dispose(), [protonDots]);
  useEffect(() => () => electronDots.dispose(), [electronDots]);
  const protonDotMaterial = useMemo(() => particleMaterial(PROTONS.base, 0.9), []);
  const electronDotMaterial = useMemo(() => particleMaterial(ELECTRONS.base, 0.8), []);

  const protonMaterial = useMemo(() => beltMaterial(PROTONS), []);
  const electronMaterial = useMemo(() => beltMaterial(ELECTRONS), []);
  useEffect(
    () => () => {
      protonMaterial.dispose();
      electronMaterial.dispose();
      protonDotMaterial.dispose();
      electronDotMaterial.dispose();
    },
    [protonMaterial, electronMaterial, protonDotMaterial, electronDotMaterial],
  );

  useFrame((state) => {
    if (!visible) return;
    const time = state.clock.elapsedTime % PARTICLE_PERIOD_S;
    const level = 0.3 + intensity * 0.7;
    for (const material of [protonMaterial, electronMaterial]) {
      material.uniforms.uTime.value = time;
      material.uniforms.uIntensity.value = level;
    }
    const scale = (state.size.height * state.viewport.dpr) / 2;
    for (const material of [protonDotMaterial, electronDotMaterial]) {
      material.uniforms.uTime.value = time;
      material.uniforms.uSqueeze.value = (1 - Math.min(1, squeeze)) * DAYSIDE_SQUEEZE;
      material.uniforms.uScale.value = scale;
    }
  });

  // Stays mounted when hidden, so its shaders are warmed up with the rest and a toggle never compiles.
  return (
    <group visible={visible}>
      <mesh geometry={protonGeometry} material={protonMaterial} />
      <mesh geometry={electronGeometry} material={electronMaterial} />
      <points geometry={protonDots} material={protonDotMaterial} frustumCulled={false} />
      <points geometry={electronDots} material={electronDotMaterial} frustumCulled={false} />
    </group>
  );
};
