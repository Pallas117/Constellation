import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface SolarWindForceFieldProps {
  visible: boolean;
  solarWindSpeed: number;     // km/s (typically 300-800)
  solarWindDensity: number;   // particles/cm³ (typically 1-20)
  compression: number;        // 0.6-1.0 magnetopause compression
  reconnectionStrength: number; // 0-1 from southward Bz
}

/**
 * Creates a hexagonal shield pattern geometry for the bow shock
 */
function createHexShieldGeometry(radius: number, segments: number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, segments, segments / 2);
  // Only keep the sunward-facing hemisphere
  const positions = geometry.attributes.position.array as Float32Array;
  const normals = geometry.attributes.normal.array as Float32Array;
  
  // Add UV coordinates for hex pattern
  const uvs: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    
    // Spherical UV mapping
    const theta = Math.atan2(z, x);
    const phi = Math.acos(Math.min(1, Math.max(-1, y / radius)));
    
    uvs.push((theta + Math.PI) / (2 * Math.PI), phi / Math.PI);
  }
  
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  
  return geometry;
}

/**
 * Solar Wind Wave Particles - Animated streams approaching Earth
 */
const SolarWindWaves = ({ 
  solarWindSpeed, 
  solarWindDensity, 
  compression 
}: { 
  solarWindSpeed: number; 
  solarWindDensity: number; 
  compression: number;
}) => {
  const wavesRef = useRef<THREE.Points>(null);
  const waveCount = 6; // Number of wave fronts
  const particlesPerWave = Math.min(200, Math.floor(50 + solarWindDensity * 10)); // Scale with density
  const totalParticles = waveCount * particlesPerWave;
  
  const { geometry, wavePhases, particleData } = useMemo(() => {
    const positions = new Float32Array(totalParticles * 3);
    const sizes = new Float32Array(totalParticles);
    const alphas = new Float32Array(totalParticles);
    const wavePhases = new Float32Array(totalParticles);
    const particleData = new Float32Array(totalParticles * 2); // theta, phi per particle
    
    for (let wave = 0; wave < waveCount; wave++) {
      const basePhase = wave / waveCount;
      
      for (let i = 0; i < particlesPerWave; i++) {
        const idx = wave * particlesPerWave + i;
        const theta = (Math.random() - 0.5) * Math.PI * 0.8; // Vertical spread
        const phi = (Math.random() - 0.5) * Math.PI * 0.8;   // Horizontal spread
        
        // Start positions (far from Earth)
        positions[idx * 3] = 35;
        positions[idx * 3 + 1] = 0;
        positions[idx * 3 + 2] = 0;
        
        sizes[idx] = 0.15 + Math.random() * 0.2;
        alphas[idx] = 0.4 + Math.random() * 0.6;
        wavePhases[idx] = basePhase + Math.random() * 0.1;
        particleData[idx * 2] = theta;
        particleData[idx * 2 + 1] = phi;
      }
    }
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    
    return { geometry, wavePhases, particleData };
  }, [totalParticles, particlesPerWave]);
  
  useFrame((state) => {
    if (!wavesRef.current) return;
    
    const positions = wavesRef.current.geometry.attributes.position.array as Float32Array;
    const time = state.clock.elapsedTime;
    
    // Speed factor: higher solar wind speed = faster wave movement
    const speedFactor = 0.15 + (solarWindSpeed - 300) / 500 * 0.25;
    const bowShockRadius = 12 * compression;
    
    for (let i = 0; i < totalParticles; i++) {
      // Wave phase determines position along the stream
      let t = (wavePhases[i] + time * speedFactor) % 1;
      
      const theta = particleData[i * 2];
      const phi = particleData[i * 2 + 1];
      
      const startX = 40;
      const endX = bowShockRadius + 0.5;
      
      // Linear approach until near the bow shock
      const approachT = Math.min(t / 0.85, 1);
      const x = startX - approachT * (startX - endX);
      
      // Particles spread out in a cone as they approach
      const spread = approachT * 0.4;
      const y = Math.sin(theta) * spread * 12 * (1 - approachT * 0.3);
      const z = Math.sin(phi) * spread * 12 * (1 - approachT * 0.3);
      
      // Add wave motion - particles oscillate slightly
      const waveY = Math.sin(time * 3 + wavePhases[i] * 20) * 0.3;
      const waveZ = Math.cos(time * 3 + wavePhases[i] * 20) * 0.3;
      
      positions[i * 3] = x;
      positions[i * 3 + 1] = y + waveY;
      positions[i * 3 + 2] = z + waveZ;
    }
    
    wavesRef.current.geometry.attributes.position.needsUpdate = true;
  });
  
  return (
    <points ref={wavesRef} geometry={geometry}>
      <shaderMaterial
        uniforms={{
          uTime: { value: 0 },
          uColor1: { value: new THREE.Color('#ffee88') },
          uColor2: { value: new THREE.Color('#ff9944') },
        }}
        vertexShader={`
          attribute float size;
          attribute float aAlpha;
          varying float vAlpha;
          varying float vDistance;
          
          void main() {
            vAlpha = aAlpha;
            vDistance = position.x / 40.0;
            
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * (300.0 / -mvPosition.z);
            gl_Position = projectionMatrix * mvPosition;
          }
        `}
        fragmentShader={`
          uniform vec3 uColor1;
          uniform vec3 uColor2;
          varying float vAlpha;
          varying float vDistance;
          
          void main() {
            float dist = length(gl_PointCoord - vec2(0.5));
            if (dist > 0.5) discard;
            
            // Glow effect
            float glow = 1.0 - smoothstep(0.0, 0.5, dist);
            glow = pow(glow, 1.5);
            
            // Color shifts from yellow (far) to orange (near)
            vec3 color = mix(uColor2, uColor1, vDistance);
            
            // Particles brighten as they approach the shield
            float intensity = 0.7 + (1.0 - vDistance) * 0.5;
            
            gl_FragColor = vec4(color * intensity, glow * vAlpha * 0.8);
          }
        `}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
};

/**
 * Force Field Shield - Hexagonal energy shield at the bow shock
 */
const ForceFieldShield = ({ 
  compression, 
  solarWindSpeed,
  solarWindDensity,
  reconnectionStrength 
}: { 
  compression: number;
  solarWindSpeed: number;
  solarWindDensity: number;
  reconnectionStrength: number;
}) => {
  const shieldRef = useRef<THREE.Mesh>(null);
  
  const shieldGeometry = useMemo(() => {
    const radius = 12 * compression;
    // Partial sphere for bow shock shape
    const geometry = new THREE.SphereGeometry(radius, 48, 24, 0, Math.PI, 0, Math.PI);
    return geometry;
  }, [compression]);
  
  const shieldMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPressure: { value: 0.5 },
        uReconnection: { value: 0 },
        uBaseColor: { value: new THREE.Color('#00ddff') },
        uImpactColor: { value: new THREE.Color('#88ffff') },
        uReconnectionColor: { value: new THREE.Color('#ff4488') },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying vec3 vWorldPosition;
        varying float vFresnel;
        varying vec2 vUv;
        
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vPosition = position;
          vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
          vUv = uv;
          
          vec3 viewDir = normalize(cameraPosition - vWorldPosition);
          vFresnel = pow(1.0 - abs(dot(viewDir, vNormal)), 2.5);
          
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uPressure;
        uniform float uReconnection;
        uniform vec3 uBaseColor;
        uniform vec3 uImpactColor;
        uniform vec3 uReconnectionColor;
        
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying vec3 vWorldPosition;
        varying float vFresnel;
        varying vec2 vUv;
        
        // Hexagonal pattern
        float hexPattern(vec2 p, float scale) {
          p *= scale;
          vec2 h = vec2(1.0, sqrt(3.0));
          vec2 a = mod(p, h) - h * 0.5;
          vec2 b = mod(p - h * 0.5, h) - h * 0.5;
          
          float d = min(dot(a, a), dot(b, b));
          return sqrt(d);
        }
        
        void main() {
          // Create hexagonal shield pattern
          vec2 hexUv = vec2(
            atan(vPosition.z, vPosition.y) / 3.14159,
            vPosition.x / 12.0
          );
          
          float hex = hexPattern(hexUv, 8.0);
          float hexEdge = smoothstep(0.15, 0.2, hex);
          float hexGlow = 1.0 - smoothstep(0.0, 0.25, hex);
          
          // Impact waves - ripples spreading from center
          float impactWave1 = sin(length(vPosition.yz) * 3.0 - uTime * 4.0) * 0.5 + 0.5;
          float impactWave2 = sin(length(vPosition.yz) * 5.0 - uTime * 6.0 + 1.0) * 0.5 + 0.5;
          float impactRipple = impactWave1 * impactWave2 * uPressure;
          
          // Forward-facing glow (where solar wind hits)
          float forwardGlow = smoothstep(-0.3, 0.8, vNormal.x);
          
          // Combine colors
          vec3 color = uBaseColor;
          
          // Add hex pattern glow
          color += uImpactColor * hexGlow * 0.5;
          
          // Add impact ripples
          color += uImpactColor * impactRipple * forwardGlow * 0.8;
          
          // Reconnection effect (red glow when Bz southward)
          float reconnectPulse = sin(uTime * 3.0) * 0.5 + 0.5;
          color = mix(color, uReconnectionColor, uReconnection * reconnectPulse * 0.4);
          
          // Edge lines (hex pattern)
          float edgeLine = 1.0 - hexEdge;
          color += vec3(0.5, 0.8, 1.0) * edgeLine * 0.3;
          
          // Fresnel edge glow
          color += uBaseColor * vFresnel * 0.6;
          
          // Alpha based on fresnel, hex pattern, and impact
          float alpha = vFresnel * 0.6;
          alpha += hexGlow * 0.2;
          alpha += impactRipple * forwardGlow * 0.3;
          alpha += edgeLine * 0.15;
          
          // Clamp alpha
          alpha = clamp(alpha, 0.0, 0.7);
          
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }, []);
  
  useFrame((state) => {
    if (!shieldRef.current || !shieldMaterial) return;
    
    const material = shieldRef.current.material as THREE.ShaderMaterial;
    material.uniforms.uTime.value = state.clock.elapsedTime;
    
    // Pressure from solar wind (normalized)
    const pressure = Math.min(1, (solarWindDensity / 10) * (solarWindSpeed / 500));
    material.uniforms.uPressure.value = pressure;
    material.uniforms.uReconnection.value = reconnectionStrength;
  });
  
  return (
    <mesh
      ref={shieldRef}
      geometry={shieldGeometry}
      material={shieldMaterial}
      rotation={[0, -Math.PI / 2, 0]}
      position={[0, 0, 0]}
    />
  );
};

/**
 * Impact Ripples - Visible energy waves when solar wind collides with shield
 */
const ImpactRipples = ({ 
  compression, 
  solarWindSpeed,
  solarWindDensity 
}: { 
  compression: number;
  solarWindSpeed: number;
  solarWindDensity: number;
}) => {
  const ripplesRef = useRef<THREE.Mesh>(null);
  
  const rippleMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0.5 },
        uRippleSpeed: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vPosition;
        
        void main() {
          vUv = uv;
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        uniform float uRippleSpeed;
        
        varying vec2 vUv;
        varying vec3 vPosition;
        
        void main() {
          vec2 center = vec2(0.5, 0.5);
          float dist = length(vUv - center);
          
          // Multiple expanding ripple rings
          float ripple1 = sin(dist * 15.0 - uTime * uRippleSpeed * 4.0);
          float ripple2 = sin(dist * 20.0 - uTime * uRippleSpeed * 5.0 + 1.5);
          float ripple3 = sin(dist * 12.0 - uTime * uRippleSpeed * 3.0 + 3.0);
          
          // Combine ripples with falloff
          float ripple = (ripple1 + ripple2 + ripple3) / 3.0;
          ripple = ripple * 0.5 + 0.5;
          ripple *= 1.0 - smoothstep(0.0, 0.5, dist);
          
          vec3 color = vec3(0.3, 0.8, 1.0);
          float alpha = ripple * uIntensity * 0.4;
          
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }, []);
  
  useFrame((state) => {
    if (!ripplesRef.current) return;
    
    const material = ripplesRef.current.material as THREE.ShaderMaterial;
    material.uniforms.uTime.value = state.clock.elapsedTime;
    
    // Intensity and speed based on solar wind
    const intensity = Math.min(1, (solarWindDensity / 10) * (solarWindSpeed / 400));
    const speed = 0.5 + (solarWindSpeed - 300) / 500 * 1.5;
    
    material.uniforms.uIntensity.value = intensity;
    material.uniforms.uRippleSpeed.value = speed;
  });
  
  const radius = 12 * compression;
  
  return (
    <mesh
      ref={ripplesRef}
      material={rippleMaterial}
      position={[radius + 0.1, 0, 0]}
      rotation={[0, Math.PI / 2, 0]}
    >
      <planeGeometry args={[radius * 1.8, radius * 1.8]} />
    </mesh>
  );
};

/**
 * Main Solar Wind Force Field Component
 */
export const SolarWindForceField = ({
  visible,
  solarWindSpeed,
  solarWindDensity,
  compression,
  reconnectionStrength,
}: SolarWindForceFieldProps) => {
  if (!visible) return null;
  
  return (
    <group>
      {/* Incoming solar wind waves */}
      <SolarWindWaves
        solarWindSpeed={solarWindSpeed}
        solarWindDensity={solarWindDensity}
        compression={compression}
      />
      
      {/* Force field shield at bow shock */}
      <ForceFieldShield
        compression={compression}
        solarWindSpeed={solarWindSpeed}
        solarWindDensity={solarWindDensity}
        reconnectionStrength={reconnectionStrength}
      />
      
      {/* Impact ripples where solar wind hits */}
      <ImpactRipples
        compression={compression}
        solarWindSpeed={solarWindSpeed}
        solarWindDensity={solarWindDensity}
      />
    </group>
  );
};
