---
name: gauss-frontend-design
description: Design system, component inventory, react-three-fiber scene conventions and visual verification workflow for the Gauss operator frontend. Use before building or restyling dashboards, HUD panels, 3D visualisations (magnetosphere, belts, radiation overlays) or any UI/UX work in frontend/.
---

# Gauss frontend & UI/UX

## Stack
React 18 + Vite (`frontend/vite.config.ts`, alias `@` → `frontend/src`), Tailwind + shadcn/ui (`frontend/src/components/ui/*`), three 0.169 + @react-three/fiber 8 + drei 9, React Router in `frontend/src/Cybertiger.tsx`.

## Design language ("Skunkworks phosphor")
Tokens in `frontend/src/index.css`:
- `--background` pure black; `--foreground`/`--primary` phosphor green `142 100% 50%`; `--muted-foreground` desaturated green.
- `--amber` caution; `--destructive` red only for real alarms.
- `--radius: 0` (sharp edges), JetBrains Mono everywhere, uppercase tracked labels for HUD chrome.
- Panels: `Card` on `bg-card`, `border-primary/20`, `backdrop-blur` overlays on the canvas.
- Numbers: `tabular-nums`, units always shown (Rₑ, nT, nPa, km/s).

## 3D scene conventions (`frontend/src/components/scene/`)
- 1 scene unit = 1 Earth radius. The Sun is along +x. Scene axes = GSM `(x, z, −y)`: use `gsmToScene` from `@/lib/physics/geomagnetic`.
- `SpaceScene.tsx` owns the camera, controls, lights and layer composition. Layers are toggled via `LayerVisibility` (`components/types.ts`).
- `Magnetosphere.tsx` renders the traced field model: Shue magnetopause, bow shock, tail current sheet, field lines (one fat-line draw call), tracers and auroral ovals. It takes live `drivers` (Bz, By, Pdyn, Kp). Without them it falls back to the legacy normalised `compression`/`reconnectionStrength`.
- Additive-blended glow materials use `depthWrite={false}`. Memoise geometry/materials and update uniforms in `useFrame`. Never allocate per frame.
- Put physics and maths in `frontend/src/lib/**` with `node:test` coverage (`node --import tsx --test <file>`).

## UX checklist
- Show data source, age and mock/simulated state visibly (e.g. "Simulate G4 Storm" pill).
- Canvas has `role="application"` and an `aria-label`, and keyboard controls work (arrows, +/−, R).
- Contrast AA on `bg-card`; never use colour alone for state; add a label or icon.
- Respect `prefers-reduced-motion` for non-essential animation.
- Mobile: check 375px width; panels stack (`lg:grid-cols-[1fr_320px]` pattern).

## Verify
1. `npx tsc --noEmit -p frontend/tsconfig.app.json`. Errors already exist in radiation utils, PublicDashboard and others, so report only new ones.
2. Run Vite on a free port (`npx vite --config frontend/vite.config.ts --port 8091 --strictPort`) and open `/heliophysics` (public) in the Browser pane. Wait ~5 s for the canvas, check console errors and take a screenshot.
3. Data hooks must only poll routes the viewer's role can use (`PUBLIC_READ_PATHS` for signed-out pages). CyberTiger counts 401/403s and auto-blocks the IP, so a 401 in the console is a bug, not noise.
4. `npm run build` before a PR.
