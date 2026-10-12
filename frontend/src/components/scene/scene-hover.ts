/**
 * What the pointer is over in the 3D scene, for the HUD's hover readout.
 *
 * A tiny external store rather than React state: pointer moves re-render only
 * the tooltip that subscribes, never the page or the scene.
 */
import { useSyncExternalStore } from 'react';
import type { Object3D } from 'three';
import type { ThreeEvent } from '@react-three/fiber';

export type HoverTarget = 'earth' | 'magnetopause' | 'currentSheet' | 'bowShock';

export interface SceneHover {
  target: HoverTarget;
  /** Viewport (client) coordinates of the pointer. */
  x: number;
  y: number;
}

let current: SceneHover | null = null;
const listeners = new Set<() => void>();

export function setSceneHover(next: SceneHover | null) {
  if (next === null && current === null) return;
  current = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => current;

export const useSceneHover = () => useSyncExternalStore(subscribe, snapshot, snapshot);

/** The shells are nested and see-through, so the innermost one under the pointer wins. */
const PRIORITY: Record<HoverTarget, number> = { earth: 0, magnetopause: 1, currentSheet: 2, bowShock: 3 };

function targetOf(obj: Object3D | null): HoverTarget | undefined {
  for (let o = obj, depth = 0; o && depth < 4; o = o.parent, depth++) {
    const t = o.userData.hoverTarget as HoverTarget | undefined;
    if (t) return t;
  }
  return undefined;
}

let lastEvent: Event | null = null;

/**
 * Pointer handlers for a hoverable object; tag it with `userData={{ hoverTarget }}`.
 * Only tagged objects get handlers, so the 40k field-line segments and the
 * particle clouds are never raycast.
 */
export const hoverHandlers = {
  onPointerMove(e: ThreeEvent<PointerEvent>) {
    // Every hit object gets this event; the first decides for all. (Not
    // stopPropagation: in R3F that sends pointerout to the shells behind.)
    if (e.nativeEvent === lastEvent) return;
    lastEvent = e.nativeEvent;
    if (e.buttons !== 0) {
      setSceneHover(null); // orbiting, not inspecting
      return;
    }
    let best: HoverTarget | undefined;
    for (const hit of e.intersections) {
      const t = targetOf(hit.object);
      if (t && (best === undefined || PRIORITY[t] < PRIORITY[best])) best = t;
    }
    setSceneHover(best ? { target: best, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY } : null);
  },
  onPointerOut() {
    setSceneHover(null);
  },
};
