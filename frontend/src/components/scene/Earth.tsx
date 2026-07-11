/**
 * Earth Component
 * 3D Earth globe with procedural texture and atmosphere
 * 
 * Note: Client-side component - uses WebGL/Three.js
 */

'use client'; // Mark as client component (for Next.js compatibility, if migrated)

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Sphere, useTexture } from '@react-three/drei';
import * as THREE from 'three';

interface EarthProps {
  visible: boolean;
}

export const Earth = ({ visible }: EarthProps) => {
  const earthRef = useRef<THREE.Mesh>(null);
  const cloudsRef = useRef<THREE.Mesh>(null);
  const atmosphereRef = useRef<THREE.Mesh>(null);

  // Create procedural Earth texture
  const earthMaterial = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;

    // Deep blue ocean base
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, 0, 512, 256);

    // Add continents (simplified)
    ctx.fillStyle = '#1a3a2a';
    
    // North America
    ctx.beginPath();
    ctx.ellipse(100, 80, 50, 40, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // South America
    ctx.beginPath();
    ctx.ellipse(130, 170, 25, 45, 0.3, 0, Math.PI * 2);
    ctx.fill();
    
    // Europe/Africa
    ctx.beginPath();
    ctx.ellipse(270, 100, 30, 60, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // Asia
    ctx.beginPath();
    ctx.ellipse(380, 80, 70, 50, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // Australia
    ctx.beginPath();
    ctx.ellipse(430, 180, 25, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    // Add some variation
    for (let i = 0; i < 200; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 256;
      const r = Math.random() * 10 + 2;
      ctx.fillStyle = `rgba(${20 + Math.random() * 20}, ${50 + Math.random() * 30}, ${40 + Math.random() * 20}, 0.3)`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    return new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.8,
      metalness: 0.1,
    });
  }, []);

  const atmosphereMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color('#00d4ff') },
        viewVector: { value: new THREE.Vector3(0, 0, 1) },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPositionNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vPositionNormal = normalize((modelViewMatrix * vec4(position, 1.0)).xyz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        varying vec3 vNormal;
        varying vec3 vPositionNormal;
        void main() {
          float intensity = pow(0.7 - dot(vNormal, vPositionNormal), 2.0);
          gl_FragColor = vec4(glowColor, 1.0) * intensity * 0.6;
        }
      `,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });
  }, []);

  useFrame((state, delta) => {
    if (earthRef.current && visible) {
      earthRef.current.rotation.y += delta * 0.05;
    }
    if (cloudsRef.current && visible) {
      cloudsRef.current.rotation.y += delta * 0.07;
    }
  });

  if (!visible) return null;

  return (
    <group>
      {/* Earth */}
      <mesh ref={earthRef} material={earthMaterial}>
        <sphereGeometry args={[1, 64, 64]} />
      </mesh>

      {/* Cloud layer */}
      <mesh ref={cloudsRef}>
        <sphereGeometry args={[1.01, 32, 32]} />
        <meshStandardMaterial
          color="#ffffff"
          transparent
          opacity={0.15}
          depthWrite={false}
        />
      </mesh>

      {/* Atmosphere glow */}
      <mesh ref={atmosphereRef} material={atmosphereMaterial}>
        <sphereGeometry args={[1.15, 32, 32]} />
      </mesh>
    </group>
  );
};
