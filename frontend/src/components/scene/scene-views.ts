export type SceneView = 'overview' | 'dayside' | 'meridian' | 'tail' | 'polar';

export type Vec = [number, number, number];
/** Camera position and orbit target per preset (scene units = Earth radii, Sun at +x). */
export const SCENE_VIEWS: Record<SceneView, { position: Vec; target: Vec; label: string }> = {
  overview: { position: [6, 5, 18], target: [0, 0, 0], label: 'Overview' },
  dayside: { position: [26, 4, 6], target: [3, 0, 0], label: 'From the Sun' },
  meridian: { position: [-4, 2, 44], target: [-6, 0, 0], label: 'Noon–midnight' },
  tail: { position: [-34, 9, 16], target: [-12, 0, 0], label: 'Magnetotail' },
  polar: { position: [-1.5, 24, 3], target: [0, 0, 0], label: 'North pole' },
};
