import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

interface MagnetosphereProps {
  visible: boolean;
  compression: number;
  reconnectionStrength: number;
}

/**
 * Generate dipole field line points following r = L * cos²(λ)
 */
function generateDipoleFieldLine(
  L: number,
  phi: number,
  steps: number,
  isOpen: boolean,
  tailLength: number
): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  
  const latRange = isOpen ? 75 : 85; // degrees
  
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lambda = (t - 0.5) * 2 * latRange * (Math.PI / 180);
    const cosLambda = Math.cos(lambda);
    const cos2Lambda = cosLambda * cosLambda;
    
    let r = L * cos2Lambda;
    
    // For open field lines, stretch toward tail on nightside
    if (isOpen && Math.abs(lambda) > 60 * Math.PI / 180) {
      const stretch = (Math.abs(lambda) - 60 * Math.PI / 180) / (15 * Math.PI / 180);
      r += stretch * tailLength * Math.sign(Math.cos(phi) < 0 ? -1 : 0);
    }
    
    const x = r * cosLambda * Math.cos(phi);
    const y = r * Math.sin(lambda);
    const z = r * cosLambda * Math.sin(phi);
    
    points.push(new THREE.Vector3(x, y, z));
  }
  
  return points;
}

/**
 * Create magnetotail geometry - elongated parabolic cavity
 */
function createMagnetotailGeometry(
  length: number,
  startRadius: number,
  segments: number,
  rings: number
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    // Parabolic flaring: radius increases slowly then more at the end
    const x = -startRadius - t * length;
    const flareFactor = 1 + t * 0.3 + t * t * 0.5;
    const radius = startRadius * flareFactor;
    
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      const y = radius * Math.sin(theta);
      const z = radius * Math.cos(theta);
      
      vertices.push(x, y, z);
      
      if (i < rings && j < segments) {
        const current = i * (segments + 1) + j;
        const next = current + segments + 1;
        indices.push(current, next, current + 1);
        indices.push(current + 1, next, next + 1);
      }
    }
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

/**
 * Plasma particles flowing along field lines - optimized
 */
const FieldLineParticles = ({ fieldLines }: { fieldLines: { points: THREE.Vector3[]; isOpen: boolean }[] }) => {
  const particlesRef = useRef<THREE.Points>(null);
  const particleCount = 150; // Reduced from 400
  const frameSkip = useRef(0);
  
  const { geometry, offsets, lineIndices } = useMemo(() => {
    const positions = new Float32Array(particleCount * 3);
    const offsets = new Float32Array(particleCount);
    const lineIndices = new Float32Array(particleCount);
    const sizes = new Float32Array(particleCount);
    const colors = new Float32Array(particleCount * 3);
    
    for (let i = 0; i < particleCount; i++) {
      const lineIdx = Math.floor(Math.random() * fieldLines.length);
      const line = fieldLines[lineIdx];
      const t = Math.random();
      const pointIdx = Math.floor(t * (line.points.length - 1));
      const point = line.points[pointIdx];
      
      positions[i * 3] = point.x;
      positions[i * 3 + 1] = point.y;
      positions[i * 3 + 2] = point.z;
      
      offsets[i] = Math.random();
      lineIndices[i] = lineIdx;
      sizes[i] = 0.06 + Math.random() * 0.1;
      
      // Color based on line type
      if (line.isOpen) {
        colors[i * 3] = 1.0;
        colors[i * 3 + 1] = 0.5;
        colors[i * 3 + 2] = 0.2;
      } else {
        colors[i * 3] = 0.2;
        colors[i * 3 + 1] = 0.7;
        colors[i * 3 + 2] = 1.0;
      }
    }
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 1));
    geometry.setAttribute('aLineIndex', new THREE.BufferAttribute(lineIndices, 1));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    
    return { geometry, offsets, lineIndices };
  }, [fieldLines]);
  
  useFrame((state) => {
    if (!particlesRef.current) return;
    
    // Skip every other frame for performance
    frameSkip.current++;
    if (frameSkip.current % 2 !== 0) return;
    
    const positions = particlesRef.current.geometry.attributes.position.array as Float32Array;
    const time = state.clock.elapsedTime;
    
    for (let i = 0; i < particleCount; i++) {
      const lineIdx = Math.floor(lineIndices[i]);
      const line = fieldLines[lineIdx];
      if (!line) continue;
      
      const speed = line.isOpen ? 0.4 : 0.25;
      let t = (offsets[i] + time * speed) % 1;
      
      const pointIdx = Math.floor(t * (line.points.length - 1));
      const nextIdx = Math.min(pointIdx + 1, line.points.length - 1);
      const frac = t * (line.points.length - 1) - pointIdx;
      
      const p1 = line.points[pointIdx];
      const p2 = line.points[nextIdx];
      
      positions[i * 3] = p1.x + (p2.x - p1.x) * frac;
      positions[i * 3 + 1] = p1.y + (p2.y - p1.y) * frac;
      positions[i * 3 + 2] = p1.z + (p2.z - p1.z) * frac;
    }
    
    particlesRef.current.geometry.attributes.position.needsUpdate = true;
  });
  
  return (
    <points ref={particlesRef} geometry={geometry}>
      <shaderMaterial
        uniforms={{
          uTime: { value: 0 },
        }}
        vertexShader={`
          attribute float size;
          attribute vec3 color;
          varying vec3 vColor;
          
          void main() {
            vColor = color;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * (200.0 / -mvPosition.z);
            gl_Position = projectionMatrix * mvPosition;
          }
        `}
        fragmentShader={`
          varying vec3 vColor;
          
          void main() {
            float dist = length(gl_PointCoord - vec2(0.5));
            if (dist > 0.5) discard;
            
            float alpha = 1.0 - smoothstep(0.2, 0.5, dist);
            gl_FragColor = vec4(vColor, alpha * 0.8);
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
 * Particles flowing through magnetotail current sheet - optimized
 */
const CurrentSheetParticles = () => {
  const particlesRef = useRef<THREE.Points>(null);
  const particleCount = 100; // Reduced from 300
  const frameSkip = useRef(0);
  
  const { geometry, offsets, yOffsets } = useMemo(() => {
    const positions = new Float32Array(particleCount * 3);
    const offsets = new Float32Array(particleCount);
    const yOffsets = new Float32Array(particleCount);
    const sizes = new Float32Array(particleCount);
    
    for (let i = 0; i < particleCount; i++) {
      const t = Math.random();
      const x = -4 - t * 35;
      const y = (Math.random() - 0.5) * 1.5;
      const z = (Math.random() - 0.5) * 6;
      
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      
      offsets[i] = Math.random();
      yOffsets[i] = y;
      sizes[i] = 0.1 + Math.random() * 0.12;
    }
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    
    return { geometry, offsets, yOffsets };
  }, []);
  
  useFrame((state) => {
    if (!particlesRef.current) return;
    
    // Skip frames for performance
    frameSkip.current++;
    if (frameSkip.current % 2 !== 0) return;
    
    const positions = particlesRef.current.geometry.attributes.position.array as Float32Array;
    const time = state.clock.elapsedTime;
    
    for (let i = 0; i < particleCount; i++) {
      let t = (offsets[i] + time * 0.15) % 1;
      const x = -4 - t * 35;
      const waver = Math.sin(time * 2 + offsets[i] * 10) * 0.2;
      
      positions[i * 3] = x;
      positions[i * 3 + 1] = yOffsets[i] + waver;
    }
    
    particlesRef.current.geometry.attributes.position.needsUpdate = true;
  });
  
  return (
    <points ref={particlesRef} geometry={geometry}>
      <shaderMaterial
        vertexShader={`
          attribute float size;
          varying float vIntensity;
          
          void main() {
            vIntensity = 1.0 - smoothstep(-4.0, -39.0, position.x);
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * (200.0 / -mvPosition.z) * vIntensity;
            gl_Position = projectionMatrix * mvPosition;
          }
        `}
        fragmentShader={`
          varying float vIntensity;
          
          void main() {
            float dist = length(gl_PointCoord - vec2(0.5));
            if (dist > 0.5) discard;
            
            float alpha = (1.0 - smoothstep(0.1, 0.5, dist)) * vIntensity;
            vec3 color = vec3(1.0, 0.6, 0.2);
            gl_FragColor = vec4(color, alpha * 0.7);
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
 * Solar wind particles hitting magnetopause - optimized
 */
const SolarWindParticles = ({ compression }: { compression: number }) => {
  const particlesRef = useRef<THREE.Points>(null);
  const particleCount = 80; // Reduced from 200
  const frameSkip = useRef(0);
  
  const { geometry, offsets, angles } = useMemo(() => {
    const positions = new Float32Array(particleCount * 3);
    const offsets = new Float32Array(particleCount);
    const angles = new Float32Array(particleCount * 2);
    const sizes = new Float32Array(particleCount);
    
    for (let i = 0; i < particleCount; i++) {
      const theta = (Math.random() - 0.5) * Math.PI * 0.8;
      const phi = (Math.random() - 0.5) * Math.PI * 0.8;
      
      positions[i * 3] = 20;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
      
      offsets[i] = Math.random();
      angles[i * 2] = theta;
      angles[i * 2 + 1] = phi;
      sizes[i] = 0.08 + Math.random() * 0.08;
    }
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    
    return { geometry, offsets, angles };
  }, []);
  
  useFrame((state) => {
    if (!particlesRef.current) return;
    
    // Skip frames for performance
    frameSkip.current++;
    if (frameSkip.current % 2 !== 0) return;
    
    const positions = particlesRef.current.geometry.attributes.position.array as Float32Array;
    const time = state.clock.elapsedTime;
    const r0 = 10 * compression;
    
    for (let i = 0; i < particleCount; i++) {
      const speed = 0.3;
      let t = (offsets[i] + time * speed) % 1;
      
      const startX = 25;
      const endX = r0 + 1;
      
      const theta = angles[i * 2];
      const phi = angles[i * 2 + 1];
      
      if (t < 0.7) {
        const x = startX - t * (startX - endX) / 0.7;
        const spread = t * 0.5;
        const y = Math.sin(theta) * spread * 3;
        const z = Math.sin(phi) * spread * 3;
        
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
      } else {
        const deflectT = (t - 0.7) / 0.3;
        const deflectAngle = deflectT * Math.PI * 0.5;
        
        const r = r0 + 1 + deflectT * 2;
        const x = r * Math.cos(deflectAngle + theta * 0.3);
        const y = Math.sin(theta) * (1 + deflectT * 4);
        const z = Math.sin(phi) * (1 + deflectT * 4);
        
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
      }
    }
    
    particlesRef.current.geometry.attributes.position.needsUpdate = true;
  });
  
  return (
    <points ref={particlesRef} geometry={geometry}>
      <shaderMaterial
        vertexShader={`
          attribute float size;
          
          void main() {
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = size * (200.0 / -mvPosition.z);
            gl_Position = projectionMatrix * mvPosition;
          }
        `}
        fragmentShader={`
          void main() {
            float dist = length(gl_PointCoord - vec2(0.5));
            if (dist > 0.5) discard;
            
            float alpha = 1.0 - smoothstep(0.1, 0.5, dist);
            vec3 color = vec3(1.0, 0.9, 0.4);
            gl_FragColor = vec4(color, alpha * 0.6);
          }
        `}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
};

export const Magnetosphere = ({ visible, compression, reconnectionStrength }: MagnetosphereProps) => {
  const magnetopauseRef = useRef<THREE.Mesh>(null);
  const fieldLinesRef = useRef<THREE.Group>(null);

  // Create magnetopause geometry - reduced segments (32x16 instead of 64x32)
  const magnetopauseGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const segments = 32;
    const rings = 16;
    const vertices: number[] = [];
    const indices: number[] = [];

    const r0 = 10 * compression;
    const alpha = 0.5;

    for (let i = 0; i <= rings; i++) {
      const theta = (i / rings) * Math.PI - Math.PI / 2;
      
      for (let j = 0; j <= segments; j++) {
        const phi = (j / segments) * Math.PI * 2;
        
        const cosTheta = Math.cos(theta);
        const r = theta > 0 
          ? r0 * Math.pow(2 / (1 + cosTheta), alpha)
          : r0 * Math.pow(2 / (1 + cosTheta), alpha) * (1 + theta * 0.3);

        const x = r * Math.cos(theta) * Math.cos(phi);
        const y = r * Math.sin(theta);
        const z = r * Math.cos(theta) * Math.sin(phi);

        vertices.push(x, y, z);

        if (i < rings && j < segments) {
          const current = i * (segments + 1) + j;
          const next = current + segments + 1;

          indices.push(current, next, current + 1);
          indices.push(current + 1, next, next + 1);
        }
      }
    }

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    return geometry;
  }, [compression]);

  const magnetopauseMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        compression: { value: compression },
        reconnection: { value: reconnectionStrength },
        baseColor: { value: new THREE.Color('#00d4ff') },
        glowColor: { value: new THREE.Color('#00ffff') },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying float vFresnel;
        
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vPosition = position;
          
          vec3 viewDir = normalize(cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz);
          vFresnel = pow(1.0 - abs(dot(viewDir, vNormal)), 2.0);
          
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform float compression;
        uniform float reconnection;
        uniform vec3 baseColor;
        uniform vec3 glowColor;
        
        varying vec3 vNormal;
        varying vec3 vPosition;
        varying float vFresnel;
        
        void main() {
          float flow = sin(vPosition.x * 0.5 - time * 0.5) * 0.5 + 0.5;
          float pulse = sin(time * 2.0 + vPosition.y * 0.3) * 0.3 + 0.7;
          
          vec3 color = mix(baseColor, glowColor, vFresnel * 0.5 + flow * 0.2);
          color += glowColor * reconnection * 0.5;
          
          float alpha = vFresnel * 0.4 * pulse;
          alpha = clamp(alpha, 0.05, 0.5);
          
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }, [compression, reconnectionStrength]);

  // Magnetotail geometry - reduced segments (16x12 instead of 32x24)
  const magnetotailGeometry = useMemo(() => {
    return createMagnetotailGeometry(35, 4, 16, 12);
  }, []);

  const magnetotailMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec3 vPosition;
        varying float vDistance;
        
        void main() {
          vPosition = position;
          vDistance = -position.x; // Distance along tail
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec3 vPosition;
        varying float vDistance;
        
        void main() {
          // Fade out toward tail end
          float distanceFade = 1.0 - smoothstep(5.0, 35.0, vDistance);
          
          // Animated plasma flow toward tail
          float flow = sin(vDistance * 0.3 + uTime * 1.5) * 0.3 + 0.7;
          
          // Color gradient: cyan near Earth, darker blue toward tail
          vec3 nearColor = vec3(0.0, 0.8, 1.0);
          vec3 farColor = vec3(0.0, 0.2, 0.5);
          vec3 color = mix(nearColor, farColor, smoothstep(0.0, 30.0, vDistance));
          
          float alpha = distanceFade * flow * 0.15;
          
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }, []);

  // Current sheet - reduced segments (16x4 instead of 32x8)
  const currentSheetGeometry = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(35, 8, 16, 4);
    const positions = geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = positions[i] - 21.5;
    }
    geometry.attributes.position.needsUpdate = true;
    return geometry;
  }, []);

  const currentSheetMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
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
        varying vec2 vUv;
        varying vec3 vPosition;
        
        void main() {
          // Fade from center outward (Y direction)
          float centerFade = 1.0 - abs(vUv.y - 0.5) * 2.0;
          centerFade = pow(centerFade, 3.0);
          
          // Distance fade along tail
          float distanceFade = 1.0 - smoothstep(-10.0, -39.0, vPosition.x);
          
          // Animated reconnection pulses
          float pulse = sin(-vPosition.x * 0.2 + uTime * 2.0) * 0.5 + 0.5;
          
          // Hot orange-yellow color for current sheet
          vec3 color = vec3(1.0, 0.6, 0.1);
          
          float alpha = centerFade * distanceFade * (0.2 + pulse * 0.3);
          
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }, []);

  // Dipole field lines - reduced count (8 closed, 4 open instead of 12+8)
  const fieldLines = useMemo(() => {
    const lines: { points: THREE.Vector3[]; isOpen: boolean }[] = [];
    
    // Closed field lines on dayside (8 lines instead of 12)
    for (let i = 0; i < 8; i++) {
      const phi = (i / 8) * Math.PI * 2;
      const L = 2.5 + Math.random() * 1.5;
      const points = generateDipoleFieldLine(L, phi, 24, false, 0);
      lines.push({ points, isOpen: false });
    }
    
    // Open field lines connecting to tail (4 lines instead of 8)
    for (let i = 0; i < 4; i++) {
      const phi = Math.PI + (i / 4 - 0.5) * Math.PI * 0.6;
      const L = 4 + Math.random() * 2;
      const points = generateDipoleFieldLine(L, phi, 24, true, 15);
      lines.push({ points, isOpen: true });
    }

    return lines;
  }, []);

  useFrame((state) => {
    if (magnetopauseMaterial) {
      magnetopauseMaterial.uniforms.time.value = state.clock.elapsedTime;
      magnetopauseMaterial.uniforms.compression.value = compression;
      magnetopauseMaterial.uniforms.reconnection.value = reconnectionStrength;
    }
    if (magnetotailMaterial) {
      magnetotailMaterial.uniforms.uTime.value = state.clock.elapsedTime;
    }
    if (currentSheetMaterial) {
      currentSheetMaterial.uniforms.uTime.value = state.clock.elapsedTime;
    }
    if (fieldLinesRef.current) {
      fieldLinesRef.current.rotation.y += 0.0005;
    }
  });

  if (!visible) return null;

  return (
    <group>
      {/* Magnetopause surface */}
      <mesh
        ref={magnetopauseRef}
        geometry={magnetopauseGeometry}
        material={magnetopauseMaterial}
        rotation={[0, Math.PI / 2, 0]}
      />

      {/* Magnetotail - elongated parabolic cavity */}
      <mesh
        geometry={magnetotailGeometry}
        material={magnetotailMaterial}
      />

      {/* Current sheet in magnetotail */}
      <mesh
        geometry={currentSheetGeometry}
        material={currentSheetMaterial}
        rotation={[Math.PI / 2, 0, 0]}
      />

      {/* Plasma particles along field lines */}
      <FieldLineParticles fieldLines={fieldLines} />
      
      {/* Particles flowing through current sheet */}
      <CurrentSheetParticles />
      
      {/* Solar wind particles hitting magnetopause */}
      <SolarWindParticles compression={compression} />

      {/* Dipole field lines */}
      <group ref={fieldLinesRef}>
        {fieldLines.map((line, index) => (
          <line key={index}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                count={line.points.length}
                array={new Float32Array(line.points.flatMap(p => [p.x, p.y, p.z]))}
                itemSize={3}
              />
            </bufferGeometry>
            <lineBasicMaterial
              color={line.isOpen ? "#ff6644" : "#00aaff"}
              transparent
              opacity={line.isOpen ? 0.4 : 0.3}
              linewidth={1}
            />
          </line>
        ))}
      </group>
    </group>
  );
};
