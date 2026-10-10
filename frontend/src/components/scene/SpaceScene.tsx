/**
 * Space Scene Component
 * Main 3D visualization scene with Earth, orbits, and radiation data
 * 
 * Note: Client-side component - uses WebGL/Three.js
 */

'use client'; // Mark as client component (for Next.js compatibility, if migrated)

import { Suspense, useRef, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Stars, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { Earth } from './Earth';
import { VanAllenBelts } from './VanAllenBelts';
import { Magnetosphere } from './Magnetosphere';
import { dipoleTiltRad, type SolarWindDrivers } from '@/lib/physics/geomagnetic';
import { useNow } from '@/hooks/useNow';
import { OrbitRings } from './OrbitRings';
import { RadiationDataOverlay } from './RadiationDataOverlay';
import { RadiationDataOverlayLOD } from './RadiationDataOverlayLOD';
import { MHDWaves } from './MHDWaves';
import type { RadiationDataPoint } from '@/lib/types/radiation';
import type { MMSReconVectorPoint } from '@/lib/types/space-weather';
import { MMSReconnectionVectors } from './MMSReconnectionVectors';
import { SpaceObjectOverlay } from './SpaceObjectOverlay';
import type { SpaceObjectCatalogEntry, SpaceObjectDetectionAlert } from '@/lib/types/space-object';

interface LayerVisibility {
  earth: boolean;
  belts: boolean;
  magnetosphere: boolean;
  fieldLines: boolean;
  mhdWaves?: boolean;
  orbitRings?: boolean;
  radiationData?: boolean;
  mmsReconnection?: boolean;
}

interface SpaceSceneProps {
  layers: LayerVisibility;
  magnetopauseCompression: number;
  beltIntensity: number;
  reconnectionStrength: number;
  highFidelity?: boolean;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  /** Radiation data points to visualize */
  data?: RadiationDataPoint[];
  /** Orbit types to display (LEO, MEO, GEO) */
  orbitFilter?: string[];
  /** Known orbital objects for cross-reference visualization */
  spaceObjects?: SpaceObjectCatalogEntry[];
  /** Detection alerts for untracked spacecraft candidates */
  spaceObjectAlert?: SpaceObjectDetectionAlert | null;
  /** Callback when a radiation data point is clicked */
  onDataPointClick?: (point: RadiationDataPoint) => void;
  /** Enable LOD optimization (default: true) */
  enableLOD?: boolean;
  /** Manual LOD level (0-3, overrides auto if provided) */
  lodLevel?: number;
  /** Encoding mode for radiation data: 'color', 'size', or 'both' */
  encodingMode?: 'color' | 'size' | 'both';
  /** MMS tetrahedron-derived reconnection vectors */
  mmsVectors?: MMSReconVectorPoint[];
  /** Live solar wind drivers for the field-line model (Bz/By nT, Pdyn nPa, Kp) */
  solarWindDrivers?: Partial<SolarWindDrivers>;
}

const DEFAULT_CAMERA: [number, number, number] = [6, 5, 18];

const SceneContent = ({
  layers,
  magnetopauseCompression,
  beltIntensity,
  reconnectionStrength,
  data,
  orbitFilter = ['LEO', 'MEO', 'GEO'],
  spaceObjects,
  spaceObjectAlert,
  onDataPointClick,
  enableLOD = true,
  lodLevel,
  encodingMode = 'color',
  mmsVectors,
  highFidelity,
  solarWindDrivers,
}: Omit<SpaceSceneProps, 'canvasRef'>) => {
  const groupRef = useRef<THREE.Group>(null);
  // GSM frame: the dipole tilts toward/away from the Sun with season and UT.
  const epochMs = useNow(5 * 60_000);
  const dipoleTilt = useMemo(() => dipoleTiltRad(epochMs), [epochMs]);
  const controlsRef = useRef<any>(null);
  const { camera } = useThree();

  useFrame((state) => {
    // Subtle scene rotation for dynamic feel
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.1) * 0.1;
    }
  });

  // Keyboard navigation for globe control
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!controlsRef.current) return;

      // Don't intercept keyboard events if user is typing in an input, textarea, or contenteditable element
      const target = event.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.closest('input, textarea, [contenteditable="true"]'))
      ) {
        return;
      }

      const rotationSpeed = 0.05;
      const zoomSpeed = 0.5;
      const panSpeed = 0.1;

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          // Rotate left
          if (groupRef.current) {
            groupRef.current.rotation.y += rotationSpeed;
          }
          break;
        case 'ArrowRight':
          event.preventDefault();
          // Rotate right
          if (groupRef.current) {
            groupRef.current.rotation.y -= rotationSpeed;
          }
          break;
        case 'ArrowUp':
          event.preventDefault();
          // Rotate up
          if (groupRef.current) {
            groupRef.current.rotation.x += rotationSpeed;
          }
          break;
        case 'ArrowDown':
          event.preventDefault();
          // Rotate down
          if (groupRef.current) {
            groupRef.current.rotation.x -= rotationSpeed;
          }
          break;
        case '+':
        case '=':
          event.preventDefault();
          // Zoom in
          if (camera instanceof THREE.PerspectiveCamera) {
            camera.position.multiplyScalar(0.95);
            camera.updateProjectionMatrix();
          }
          break;
        case '-':
        case '_':
          event.preventDefault();
          // Zoom out
          if (camera instanceof THREE.PerspectiveCamera) {
            camera.position.multiplyScalar(1.05);
            camera.updateProjectionMatrix();
          }
          break;
        case 'r':
        case 'R':
          event.preventDefault();
          // Reset view
          if (camera instanceof THREE.PerspectiveCamera) {
            camera.position.set(...DEFAULT_CAMERA);
            camera.lookAt(0, 0, 0);
            camera.updateProjectionMatrix();
          }
          if (groupRef.current) {
            groupRef.current.rotation.set(0, 0, 0);
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [camera]);

  return (
    <>
      <PerspectiveCamera makeDefault position={DEFAULT_CAMERA} fov={45} />
      <OrbitControls
        ref={controlsRef}
        enablePan={false}
        minDistance={5}
        maxDistance={70}
        enableDamping
        dampingFactor={0.05}
        rotateSpeed={0.5}
      />

      {/* Ambient lighting */}
      <ambientLight intensity={0.1} />
      
      {/* Sun light from the right */}
      <directionalLight
        position={[20, 5, 10]}
        intensity={1.5}
        color="#fff5e6"
      />
      
      {/* Subtle fill light */}
      <pointLight position={[-10, 0, -10]} intensity={0.2} color="#4488ff" />

      {/* Stars background */}
      <Stars
        radius={100}
        depth={50}
        count={5000}
        factor={4}
        saturation={0}
        fade
        speed={0.5}
      />

      {/* Main scene group */}
      <group ref={groupRef}>
        <Earth visible={layers.earth} />
        
        {/* Belts are symmetric about the dipole axis: tilt them with it. */}
        <group rotation={[0, 0, -dipoleTilt]}>
          <VanAllenBelts
            visible={layers.belts}
            intensity={0.5 + beltIntensity * 0.5}
            compression={magnetopauseCompression}
            highFidelity={Boolean(highFidelity)}
          />
        </group>

        <Magnetosphere
          visible={layers.magnetosphere || layers.fieldLines}
          showSurfaces={layers.magnetosphere}
          showFieldLines={layers.fieldLines}
          compression={magnetopauseCompression}
          reconnectionStrength={reconnectionStrength}
          drivers={solarWindDrivers}
          epochMs={epochMs}
        />

        <MHDWaves visible={layers.mhdWaves !== false} />

        <MMSReconnectionVectors
          visible={layers.mmsReconnection !== false}
          vectors={mmsVectors ?? []}
        />

        {/* Orbit rings for LEO, MEO, GEO */}
        <OrbitRings
          visible={layers.orbitRings !== false}
          orbitFilter={orbitFilter}
        />

        <SpaceObjectOverlay
          objects={spaceObjects ?? []}
          alert={spaceObjectAlert}
          visible={layers.orbitRings !== false}
        />

        {/* Radiation data overlay with LOD optimization */}
        {data && data.length > 0 && (
          enableLOD ? (
            <RadiationDataOverlayLOD
              data={data}
              orbitFilter={orbitFilter}
              visible={layers.radiationData !== false}
              onPointClick={onDataPointClick}
              lodLevel={lodLevel}
              autoLOD={lodLevel === undefined}
              encodingMode={encodingMode}
            />
          ) : (
            <RadiationDataOverlay
              data={data}
              orbitFilter={orbitFilter}
              visible={layers.radiationData !== false}
              onPointClick={onDataPointClick}
              encodingMode={encodingMode}
            />
          )
        )}
      </group>
    </>
  );
};

export const SpaceScene = (props: SpaceSceneProps) => {
  return (
    <div
      role="application"
      aria-label="3D space weather visualization. Use arrow keys to rotate, plus/minus to zoom, and R to reset view."
      tabIndex={0}
      className="w-full h-full focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
    >
      <Canvas
        ref={props.canvasRef}
        gl={{ 
          antialias: true, 
          alpha: true,
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
        }}
        dpr={[1, 2]}
        className="w-full h-full"
      >
        <Suspense fallback={null}>
          <SceneContent {...props} />
        </Suspense>
      </Canvas>
    </div>
  );
};
