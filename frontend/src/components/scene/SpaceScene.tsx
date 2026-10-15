/**
 * Space Scene Component
 * Main 3D visualization scene with Earth, orbits, and radiation data
 *
 * Note: Client-side component - uses WebGL/Three.js
 */

'use client'; // Mark as client component (for Next.js compatibility, if migrated)

import { Component, Suspense, useCallback, useRef, useEffect, useMemo, useState, type ComponentRef, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Stars, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { Earth } from './Earth';
import { VanAllenBelts } from './VanAllenBelts';
import { Magnetosphere, type MagnetosphereModelInfo } from './Magnetosphere';
import { hoverHandlers } from './scene-hover';
import { ShaderWarmup } from './ShaderWarmup';
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
  /** Average live drivers over 5 min before tracing field lines (default true). */
  smoothDrivers?: boolean;
  /** Called with the field model each time the scene retraces. */
  onModelUpdate?: (info: MagnetosphereModelInfo) => void;
  /** Camera preset; change `viewRequest` to re-apply the same preset. */
  view?: SceneView;
  viewRequest?: number;
  /** Report Earth and the boundaries under the pointer (see scene-hover.ts). */
  hoverable?: boolean;
}

export type SceneView = 'overview' | 'dayside' | 'meridian' | 'tail' | 'polar';

type Vec = [number, number, number];
/** Camera position and orbit target per preset (scene units = Earth radii, Sun at +x). */
export const SCENE_VIEWS: Record<SceneView, { position: Vec; target: Vec; label: string }> = {
  overview: { position: [6, 5, 18], target: [0, 0, 0], label: 'Overview' },
  dayside: { position: [26, 4, 6], target: [3, 0, 0], label: 'From the Sun' },
  meridian: { position: [-4, 2, 44], target: [-6, 0, 0], label: 'Noon–midnight' },
  tail: { position: [-34, 9, 16], target: [-12, 0, 0], label: 'Magnetotail' },
  polar: { position: [-1.5, 24, 3], target: [0, 0, 0], label: 'North pole' },
};

const DEFAULT_CAMERA: Vec = SCENE_VIEWS.overview.position;

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
  smoothDrivers = true,
  onModelUpdate,
  hoverable = false,
  view = 'overview',
  viewRequest = 0,
  stage,
  onStageCommitted,
}: Omit<SpaceSceneProps, 'canvasRef'> & { stage: number; onStageCommitted: (stage: number) => void }) => {
  const groupRef = useRef<THREE.Group>(null);
  // GSM frame: the dipole tilts toward/away from the Sun with season and UT.
  const epochMs = useNow(5 * 60_000);
  const dipoleTilt = useMemo(() => dipoleTiltRad(epochMs), [epochMs]);
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera } = useThree();

  // Apply camera presets on request.
  useEffect(() => {
    const preset = SCENE_VIEWS[view] ?? SCENE_VIEWS.overview;
    camera.position.set(...preset.position);
    camera.lookAt(...preset.target);
    if (controlsRef.current) {
      controlsRef.current.target.set(...preset.target);
      controlsRef.current.update();
    }
  }, [camera, view, viewRequest]);

  // No decorative scene sway: the Sun stays fixed on +x so geometry reads as data.

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
          controlsRef.current.target.set(0, 0, 0);
          controlsRef.current.update();
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
      {stage >= STAGE.belts && (
        <Stars
          radius={100}
          depth={50}
          count={5000}
          factor={4}
          saturation={0}
          fade
          speed={0.5}
        />
      )}

      {/* Main scene group */}
      <group ref={groupRef}>
        {stage >= STAGE.earth && (
          <group {...(hoverable ? { userData: { hoverTarget: 'earth' }, ...hoverHandlers } : {})}>
            <Earth visible={layers.earth} />
          </group>
        )}

        {/* Belts are symmetric about the dipole axis: tilt them with it. */}
        {stage >= STAGE.belts && (
          <group rotation={[0, 0, -dipoleTilt]}>
            <VanAllenBelts
              visible={layers.belts}
              intensity={0.5 + beltIntensity * 0.5}
              compression={magnetopauseCompression}
              highFidelity={Boolean(highFidelity)}
            />
          </group>
        )}

        {stage >= STAGE.magnetosphere && (
          <Magnetosphere
            visible={layers.magnetosphere || layers.fieldLines}
            showSurfaces={layers.magnetosphere}
            showFieldLines={layers.fieldLines}
            compression={magnetopauseCompression}
            reconnectionStrength={reconnectionStrength}
            drivers={solarWindDrivers}
            smoothing={smoothDrivers}
            onModelUpdate={onModelUpdate}
            epochMs={epochMs}
            hoverable={hoverable}
          />
        )}

        {stage >= STAGE.rest && <MHDWaves visible={layers.mhdWaves !== false} />}

        {stage >= STAGE.rest && (
          <MMSReconnectionVectors
            visible={layers.mmsReconnection !== false}
            vectors={mmsVectors ?? []}
          />
        )}

        {/* Orbit rings for LEO, MEO, GEO */}
        {stage >= STAGE.rest && (
          <OrbitRings
            visible={layers.orbitRings !== false}
            orbitFilter={orbitFilter}
          />
        )}

        {stage >= STAGE.rest && (
          <SpaceObjectOverlay
            objects={spaceObjects ?? []}
            alert={spaceObjectAlert}
            visible={layers.orbitRings !== false}
          />
        )}

        {/* Radiation data overlay with LOD optimization */}
        {stage >= STAGE.rest && data && data.length > 0 && (
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
      <StageCommitted stage={stage} onCommit={onStageCommitted} />
    </>
  );
};

/**
 * The scene mounts in stages, one task each, instead of in one long commit:
 * the WebGL context, then Earth, then belts and stars, then the magnetosphere,
 * then the rest, then the shader warm-up. Nothing shows until the warm-up is done.
 */
const STAGE = { context: 0, earth: 1, belts: 2, magnetosphere: 3, rest: 4, warmup: 5 } as const;

/** Reports each stage once it is committed inside the R3F tree. */
function StageCommitted({ stage, onCommit }: { stage: number; onCommit: (stage: number) => void }) {
  useEffect(() => {
    onCommit(stage);
  }, [stage, onCommit]);
  return null;
}

/** Only mention the warm-up if it takes long enough to notice (a first visit). */
const PREPARING_NOTICE_MS = 400;

/**
 * Without WebGL (a blocked GPU, a locked-down browser, some VMs) the renderer
 * throws on creation. Contain it here so the page and its live readouts keep
 * working, instead of the whole route falling into the app's error screen.
 */
class SceneBoundary extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('3D scene unavailable:', error.message);
    this.props.onFail();
  }

  render() {
    if (this.state.failed) {
      return (
        <div role="status" className="flex h-full w-full items-center justify-center p-6 text-center">
          <p className="max-w-xs font-mono text-[11px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
            3D view unavailable: this browser could not start WebGL. The readouts still update live.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export const SpaceScene = (props: SpaceSceneProps) => {
  // Nothing renders until every shader is compiled: the first draw of an
  // uncompiled material blocks the main thread (see ShaderWarmup).
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const onFail = useCallback(() => setFailed(true), []);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (ready || failed) return;
    const t = window.setTimeout(() => setSlow(true), PREPARING_NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [ready, failed]);

  // Create the WebGL context in its own task, after the page's first commit.
  const [canvasOn, setCanvasOn] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setCanvasOn(true), 0);
    return () => window.clearTimeout(t);
  }, []);
  // Each committed stage schedules the next in a new task.
  const [stage, setStage] = useState<number>(STAGE.context);
  const onStageCommitted = useCallback((committed: number) => {
    if (committed >= STAGE.warmup) return;
    window.setTimeout(() => setStage((cur) => (cur === committed ? committed + 1 : cur)), 0);
  }, []);

  return (
    <div
      role="application"
      aria-label="3D space weather visualization. Use arrow keys to rotate, plus/minus to zoom, and R to reset view."
      aria-busy={!ready && !failed}
      tabIndex={0}
      className="relative w-full h-full focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-signal/40"
    >
      {canvasOn && (
        <SceneBoundary onFail={onFail}>
          <Canvas
            ref={props.canvasRef}
            frameloop={ready ? 'always' : 'never'}
            gl={{
              antialias: true,
              alpha: true,
              preserveDrawingBuffer: true,
              powerPreference: 'high-performance',
            }}
            dpr={[1, 2]}
            // Transparent until warmed up: ShaderWarmup draws a frame out of sight first.
            className={`w-full h-full transition-opacity duration-500 motion-reduce:transition-none ${ready ? 'opacity-100' : 'opacity-0'}`}
          >
            <Suspense fallback={null}>
              <SceneContent {...props} stage={stage} onStageCommitted={onStageCommitted} />
              {stage >= STAGE.warmup && <ShaderWarmup onReady={() => setReady(true)} />}
            </Suspense>
          </Canvas>
        </SceneBoundary>
      )}
      {!ready && !failed && slow && (
        <p
          role="status"
          className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
        >
          <span className="animate-pulse">Preparing the field model…</span>
        </p>
      )}
    </div>
  );
};
