/**
 * Point-sprite materials shared by scene components. They live outside the components
 * so ShaderWarmup can compile them before the first draw that needs them.
 */
import * as THREE from 'three';

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

export const GLOW_POINT_VERT = /* glsl */ `
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

export const GLOW_POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = exp(-d * d * 40.0);
    float halo = exp(-d * d * 10.0) * 0.45;
    gl_FragColor = vec4(vColor * (core + halo), core + halo);
  }
`;

/**
 * Glowing dot shader material with LOD support. Exported so the scene can compile
 * it before the first storm toggle (see ShaderWarmup).
 */
export const createGlowMaterial = (pointSize: number) => {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      glowIntensity: { value: 1.0 },
      pointSize: { value: pointSize },
    },
    // `color` is declared by three for vertexColors; declaring it again fails to compile.
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      varying float vSize;
      
      void main() {
        vColor = color;
        vSize = size;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform float glowIntensity;
      varying vec3 vColor;
      varying float vSize;
      
      void main() {
        vec2 center = gl_PointCoord - vec2(0.5);
        float dist = length(center);
        
        float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
        alpha *= glowIntensity;
        
        float pulse = sin(time * 2.0) * 0.1 + 0.9;
        alpha *= pulse;
        
        float outerGlow = 1.0 - smoothstep(0.3, 0.7, dist);
        alpha += outerGlow * 0.3 * glowIntensity;
        
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true,
  });
};
