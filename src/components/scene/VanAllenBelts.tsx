import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface VanAllenBeltsProps {
  visible: boolean;
  intensity: number;
  compression?: number;
}

/**
 * Creates L-shell geometry following dipole magnetic field equation:
 * r = L * cos²(λ) where λ is magnetic latitude
 * 
 * This creates realistic crescent-shaped radiation belt cross-sections
 * that bulge at the equator and pinch toward the poles.
 */
function createLShellGeometry(
  innerL: number,
  outerL: number,
  latitudeRange: number,
  longitudeSegments: number,
  latitudeSegments: number,
  compression: number
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Generate vertices following L-shell parametric equations
  for (let i = 0; i <= latitudeSegments; i++) {
    // Magnetic latitude from -latitudeRange to +latitudeRange
    const latFraction = i / latitudeSegments;
    const lambda = (latFraction - 0.5) * 2 * latitudeRange * (Math.PI / 180);
    const cosLambda = Math.cos(lambda);
    const cos2Lambda = cosLambda * cosLambda;

    for (let j = 0; j <= longitudeSegments; j++) {
      const lonFraction = j / longitudeSegments;
      const phi = lonFraction * Math.PI * 2;

      // Interpolate between inner and outer L-shells for belt thickness
      // Use middle of the belt for the main surface
      const L = (innerL + outerL) / 2;
      const thickness = (outerL - innerL) / 2;

      // Dipole field: r = L * cos²(λ)
      let r = L * cos2Lambda;

      // Apply day/night compression asymmetry
      // Sunward side (positive X) is compressed, nightside is stretched
      const sunwardFactor = Math.cos(phi);
      const compressionEffect = 1 - (compression - 1) * 0.15 * sunwardFactor;
      r *= compressionEffect;

      // Convert to Cartesian coordinates
      // In dipole coordinates: x = r*cos(λ)*cos(φ), y = r*sin(λ), z = r*cos(λ)*sin(φ)
      const x = r * cosLambda * Math.cos(phi);
      const y = r * Math.sin(lambda);
      const z = r * cosLambda * Math.sin(phi);

      vertices.push(x, y, z);
      uvs.push(lonFraction, latFraction);
    }
  }

  // Generate indices for triangle strip
  for (let i = 0; i < latitudeSegments; i++) {
    for (let j = 0; j < longitudeSegments; j++) {
      const current = i * (longitudeSegments + 1) + j;
      const next = current + longitudeSegments + 1;

      indices.push(current, next, current + 1);
      indices.push(current + 1, next, next + 1);
    }
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * Van Allen Belts - Optimized NASA SVS Style with L-Shell Geometry
 */
export const VanAllenBelts = ({ visible, intensity, compression = 1 }: VanAllenBeltsProps) => {
  const innerBeltRef = useRef<THREE.Mesh>(null);
  const outerBeltRef = useRef<THREE.Mesh>(null);

  // Inner belt geometry - reduced segments for performance (32x16 instead of 64x32)
  const innerBeltGeometry = useMemo(() => {
    return createLShellGeometry(1.4, 2.4, 50, 32, 16, compression);
  }, [compression]);

  // Outer belt geometry - reduced segments for performance
  const outerBeltGeometry = useMemo(() => {
    return createLShellGeometry(3.2, 5.0, 60, 32, 16, compression);
  }, [compression]);

  // Inner belt material (proton belt)
  const innerBeltMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: intensity },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vPosition;
        varying float vRadialDist;
        
        void main() {
          vUv = uv;
          vPosition = position;
          // Distance from Earth center for intensity falloff
          vRadialDist = length(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        varying vec2 vUv;
        varying vec3 vPosition;
        varying float vRadialDist;
        
        void main() {
          // NASA SVS color gradient: green → yellow → red
          vec3 lowColor = vec3(0.0, 1.0, 0.53);    // #00FF88 bright green
          vec3 midColor = vec3(1.0, 0.93, 0.0);    // #FFEE00 yellow
          vec3 highColor = vec3(1.0, 0.27, 0.0);   // #FF4400 orange-red
          
          // Color based on intensity
          vec3 color = mix(
            lowColor,
            mix(midColor, highColor, smoothstep(0.5, 1.0, uIntensity)),
            smoothstep(0.0, 0.5, uIntensity)
          );
          
          // Latitude-based intensity (stronger at equator)
          float latitudeFactor = abs(vUv.y - 0.5) * 2.0;
          float equatorBand = 1.0 - smoothstep(0.0, 0.8, latitudeFactor);
          equatorBand = pow(equatorBand, 0.6);
          
          // Radial falloff within the belt
          float normalizedR = (vRadialDist - 1.4) / (2.4 - 1.4);
          float radialBand = sin(normalizedR * 3.14159);
          radialBand = pow(radialBand, 0.5);
          
          // Subtle flow animation along longitude
          float flow = sin(vUv.x * 20.0 - uTime * 2.0) * 0.1 + 0.9;
          
          // Pulsing based on intensity
          float pulse = 0.9 + 0.1 * sin(uTime * 1.5);
          
          float alpha = equatorBand * radialBand * flow * pulse * (0.5 + uIntensity * 0.5);
          
          gl_FragColor = vec4(color * (0.8 + equatorBand * 0.4), alpha * 0.7);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }, []);

  // Outer belt material (electron belt)
  const outerBeltMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: intensity },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vPosition;
        varying float vRadialDist;
        
        void main() {
          vUv = uv;
          vPosition = position;
          vRadialDist = length(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        varying vec2 vUv;
        varying vec3 vPosition;
        varying float vRadialDist;
        
        void main() {
          // Outer belt: more blue-shifted colors for electron population
          vec3 lowColor = vec3(0.0, 0.8, 0.9);     // Cyan
          vec3 midColor = vec3(0.2, 1.0, 0.6);     // Bright green
          vec3 highColor = vec3(1.0, 0.8, 0.0);    // Golden yellow
          
          vec3 color = mix(
            lowColor,
            mix(midColor, highColor, smoothstep(0.5, 1.0, uIntensity)),
            smoothstep(0.0, 0.5, uIntensity)
          );
          
          // Latitude-based intensity with wider spread for outer belt
          float latitudeFactor = abs(vUv.y - 0.5) * 2.0;
          float equatorBand = 1.0 - smoothstep(0.0, 0.85, latitudeFactor);
          equatorBand = pow(equatorBand, 0.5);
          
          // Radial distribution - outer belt is more diffuse
          float normalizedR = (vRadialDist - 3.2) / (5.0 - 3.2);
          float radialBand = sin(normalizedR * 3.14159);
          radialBand = pow(radialBand, 0.4);
          
          // Different flow speed for outer belt
          float flow = sin(vUv.x * 15.0 - uTime * 1.5) * 0.15 + 0.85;
          
          float pulse = 0.85 + 0.15 * sin(uTime * 1.2 + 1.0);
          
          float alpha = equatorBand * radialBand * flow * pulse * (0.4 + uIntensity * 0.6);
          
          gl_FragColor = vec4(color * (0.7 + equatorBand * 0.5), alpha * 0.6);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }, []);

  useFrame((state) => {
    const time = state.clock.elapsedTime;
    const clampedIntensity = 0.3 + intensity * 0.7;
    
    if (innerBeltMaterial) {
      innerBeltMaterial.uniforms.uTime.value = time;
      innerBeltMaterial.uniforms.uIntensity.value = clampedIntensity;
    }
    if (outerBeltMaterial) {
      outerBeltMaterial.uniforms.uTime.value = time;
      outerBeltMaterial.uniforms.uIntensity.value = clampedIntensity;
    }
  });

  if (!visible) return null;

  return (
    <group>
      {/* Inner Belt - Proton belt following L-shell geometry */}
      <mesh 
        ref={innerBeltRef} 
        geometry={innerBeltGeometry}
        material={innerBeltMaterial}
        frustumCulled
      />
      
      {/* Outer Belt - Electron belt following L-shell geometry */}
      <mesh 
        ref={outerBeltRef} 
        geometry={outerBeltGeometry}
        material={outerBeltMaterial}
        frustumCulled
      />
      
      {/* Slot region glow - reduced segments */}
      <mesh>
        <torusGeometry args={[2.8, 0.12, 8, 32]} />
        <meshBasicMaterial 
          color="#001133" 
          transparent 
          opacity={0.1} 
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
};
