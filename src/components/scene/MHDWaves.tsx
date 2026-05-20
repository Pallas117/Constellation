/**
 * MHD Waves – real-time visualization of magnetohydrodynamic waves
 *
 * Renders two modes (analytical solutions, no simulation):
 * 1. Shear Alfvén wave: transverse displacement along field lines, ω = k·V_A
 * 2. Fast magnetosonic wave: compressional ripple (e.g. on a disc), ω = k·V_+
 *
 * Physics: B₀ along z; wave propagates along k. All animation is GPU (shaders).
 */

'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export type MHDWaveMode = 'shear' | 'fast' | 'both';

interface MHDWavesProps {
  visible: boolean;
  /** Which wave type(s) to show */
  mode?: MHDWaveMode;
  /** Wave amplitude (displacement scale) */
  amplitude?: number;
  /** Speed scale for animation (1 = nominal) */
  speed?: number;
}

// Nominal Alfvén speed scale (arbitrary units for visualization)
const V_A = 1.5;
// Wavenumber
const K = 2.5;

export const MHDWaves = ({
  visible,
  mode = 'both',
  amplitude = 0.4,
  speed = 1,
}: MHDWavesProps) => {
  const shearLinesRef = useRef<THREE.Group>(null);
  const fastWaveRef = useRef<THREE.Mesh>(null);

  // ---- Shear Alfvén: field lines along B (z) with transverse displacement ----
  // Displacement u_perp ∝ sin(k·z - ω·t), ω = k·V_A
  const shearGeometry = useMemo(() => {
    const numLines = 8;
    const pointsPerLine = 64;
    const zMin = -4;
    const zMax = 4;
    const vertices: number[] = [];
    const indices: number[] = [];
    let vertexCount = 0;

    for (let l = 0; l < numLines; l++) {
      const theta = (l / numLines) * Math.PI * 2;
      const radius = 0.8 + (l % 3) * 0.4;
      const baseX = radius * Math.cos(theta);
      const baseY = radius * Math.sin(theta);

      for (let i = 0; i <= pointsPerLine; i++) {
        const z = zMin + (i / pointsPerLine) * (zMax - zMin);
        vertices.push(baseX, baseY, z);
        if (i < pointsPerLine) {
          indices.push(vertexCount, vertexCount + 1);
        }
        vertexCount++;
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.setAttribute('phase', new THREE.Float32BufferAttribute(
      Array.from({ length: vertices.length / 3 }, (_, i) => {
        const stride = pointsPerLine + 1;
        const lineIndex = Math.floor(i / stride);
        const pointIndex = i % stride;
        const z = zMin + (pointIndex / pointsPerLine) * (zMax - zMin);
        return z; // pass z for sin(k*z - omega*t)
      }),
      1
    ));
    return geom;
  }, []);

  const shearMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        amplitude: { value: amplitude },
        k: { value: K },
        vA: { value: V_A },
        speed: { value: speed },
      },
      vertexShader: `
        attribute float phase;
        uniform float time;
        uniform float amplitude;
        uniform float k;
        uniform float vA;
        uniform float speed;
        void main() {
          vec3 pos = position;
          float omega = k * vA * speed;
          float wave = sin(k * phase - omega * time);
          pos.x += amplitude * wave;
          pos.y += amplitude * wave * 0.6;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        void main() {
          float pulse = 0.6 + 0.4 * sin(time * 2.0);
          gl_FragColor = vec4(0.2, 0.6, 1.0, 0.85 * pulse);
        }
      `,
      transparent: true,
      depthWrite: true,
      linewidth: 2,
    });
  }, [amplitude, speed]);

  // ---- Fast magnetosonic: ripple on a disc (compressional wave) ----
  const fastWaveGeometry = useMemo(() => {
    const segments = 64;
    const rings = 32;
    const radius = 5;
    const vertices: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let r = 0; r <= rings; r++) {
      const rr = (r / rings) * radius;
      for (let s = 0; s <= segments; s++) {
        const theta = (s / segments) * Math.PI * 2;
        const x = rr * Math.cos(theta);
        const z = rr * Math.sin(theta);
        vertices.push(x, 0, z);
        uvs.push(s / segments, r / rings);
        if (r < rings && s < segments) {
          const a = r * (segments + 1) + s;
          const b = a + segments + 1;
          indices.push(a, b, a + 1);
          indices.push(a + 1, b, b + 1);
        }
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  }, []);

  const fastWaveMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        amplitude: { value: amplitude * 0.5 },
        k: { value: K * 0.8 },
        speed: { value: speed },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying float vWave;
        uniform float time;
        uniform float amplitude;
        uniform float k;
        uniform float speed;
        void main() {
          vec3 pos = position;
          float r = length(pos.xz);
          float omega = k * 1.2 * speed;
          vWave = sin(k * r - omega * time);
          pos.y += amplitude * vWave;
          vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
          vViewPosition = -mvPos.xyz;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying float vWave;
        uniform float time;
        void main() {
          float fresnel = pow(1.0 - abs(dot(normalize(vViewPosition), vNormal)), 1.5);
          float glow = 0.4 + 0.4 * vWave + 0.2 * sin(time);
          float alpha = 0.15 + 0.25 * fresnel * glow;
          gl_FragColor = vec4(0.4, 0.9, 1.0, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }, [amplitude, speed]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (shearMaterial) {
      shearMaterial.uniforms.time.value = t;
      shearMaterial.uniforms.amplitude.value = amplitude;
      shearMaterial.uniforms.speed.value = speed;
    }
    if (fastWaveMaterial) {
      fastWaveMaterial.uniforms.time.value = t;
      fastWaveMaterial.uniforms.amplitude.value = amplitude * 0.5;
      fastWaveMaterial.uniforms.speed.value = speed;
    }
  });

  if (!visible) return null;

  const showShear = mode === 'shear' || mode === 'both';
  const showFast = mode === 'fast' || mode === 'both';

  return (
    <group name="mhd-waves">
      {showShear && (
        <group ref={shearLinesRef}>
          <lineSegments
            geometry={shearGeometry}
            material={shearMaterial}
          />
        </group>
      )}
      {showFast && (
        <mesh
          ref={fastWaveRef}
          geometry={fastWaveGeometry}
          material={fastWaveMaterial}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0, 0]}
        />
      )}
    </group>
  );
};
