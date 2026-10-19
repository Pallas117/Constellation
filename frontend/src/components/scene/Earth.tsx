/**
 * Earth as an instrument, not an illustration: Earth blue (#2378C4) lit from
 * the Sun (scene +x, GSM sunward) with a soft terminator, a 30° graticule that
 * turns with the planet, and a thin atmosphere limb. No invented coastlines.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface EarthProps {
  visible: boolean;
}

// sRGB, written as-is (ShaderMaterial skips colour management), so these are the brand hexes.
const EARTH_BLUE = '0.137, 0.471, 0.769'; // #2378C4
const NIGHT = '0.020, 0.039, 0.063'; // Earth blue at ~8%, above the #050505 ground

function globeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vObject;
      varying vec3 vNormalW;
      void main() {
        vObject = position;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vObject;
      varying vec3 vNormalW;
      const vec3 SUN = vec3(1.0, 0.0, 0.0);
      const float PI = 3.141592653589793;

      // Distance to the nearest grid line, in pixels, for a step of 'stepDeg' degrees.
      float gridLine(float angle, float stepDeg) {
        float cells = angle / radians(stepDeg);
        float d = abs(fract(cells - 0.5) - 0.5);
        return d / max(fwidth(cells), 1e-4);
      }

      void main() {
        vec3 p = normalize(vObject);
        float lat = asin(clamp(p.y, -1.0, 1.0));
        float lon = atan(p.z, p.x);

        float ndl = dot(normalize(vNormalW), SUN);
        float day = smoothstep(-0.12, 0.3, ndl);
        vec3 lit = vec3(${EARTH_BLUE}) * (0.45 + 0.55 * clamp(ndl, 0.0, 1.0));
        vec3 color = mix(vec3(${NIGHT}), lit, day);

        // Graticule: meridians fade toward the poles where they bunch up.
        float meridian = 1.0 - smoothstep(0.0, 1.2, gridLine(lon, 30.0));
        meridian *= smoothstep(1.45, 1.2, abs(lat));
        float parallel = 1.0 - smoothstep(0.0, 1.2, gridLine(lat, 30.0));
        float equator = 1.0 - smoothstep(0.0, 1.6, abs(lat) / max(fwidth(lat), 1e-4));
        float line = max(max(meridian, parallel) * 0.5, equator * 0.8);
        color += vec3(0.95, 0.94, 0.91) * line * (0.12 + 0.18 * day);

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

function limbMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormalV;
      varying vec3 vViewV;
      varying vec3 vNormalW;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewV = normalize(-mv.xyz);
        vNormalV = normalize(normalMatrix * normal);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vNormalV;
      varying vec3 vViewV;
      varying vec3 vNormalW;
      void main() {
        // Back faces of a slightly larger shell: brightest just outside the disc edge.
        float rim = pow(1.0 - abs(dot(vNormalV, vViewV)), 3.0);
        float lit = 0.35 + 0.65 * smoothstep(-0.3, 0.4, dot(vNormalW, vec3(1.0, 0.0, 0.0)));
        gl_FragColor = vec4(vec3(${EARTH_BLUE}), rim * lit * 0.8);
      }
    `,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

export const Earth = ({ visible }: EarthProps) => {
  const earthRef = useRef<THREE.Mesh>(null);
  const globe = useMemo(() => globeMaterial(), []);
  const limb = useMemo(() => limbMaterial(), []);
  useEffect(
    () => () => {
      globe.dispose();
      limb.dispose();
    },
    [globe, limb],
  );

  useFrame((_, delta) => {
    if (earthRef.current && visible) earthRef.current.rotation.y += delta * 0.05;
  });

  // Stays mounted when hidden, so its shaders are warmed up with the rest and a toggle never compiles.
  return (
    <group visible={visible}>
      <mesh ref={earthRef} material={globe}>
        <sphereGeometry args={[1, 96, 64]} />
      </mesh>
      <mesh material={limb}>
        <sphereGeometry args={[1.06, 64, 32]} />
      </mesh>
    </group>
  );
};
