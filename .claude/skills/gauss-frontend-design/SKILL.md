---
name: gauss-frontend-design
description: Design system, component inventory, react-three-fiber scene conventions and visual verification workflow for the Gauss operator frontend. Use before building or restyling dashboards, HUD panels, 3D visualisations (magnetosphere, belts, radiation overlays) or any UI/UX work in frontend/.
---

# Gauss frontend & UI/UX

## Stack
React 18 + Vite (`frontend/vite.config.ts`, alias `@` → `frontend/src`), Tailwind + shadcn/ui (`frontend/src/components/ui/*`), three 0.169 + @react-three/fiber 8 + drei 9, React Router in `frontend/src/Cybertiger.tsx`.

## Design language: Lightbound Brand Room
Source of truth is the "Lightbound Brand Room" artifact (https://claude.ai/artifact/Uxvk64fWtQovS8bpeqbg4s, 9 Oct 2026). Tokens are in `frontend/src/index.css` and the Tailwind names in `tailwind.config.cjs`:

| Token | Hex | Tailwind | Use |
|---|---|---|---|
| Black | #050505 | `bg-background` | Page ground |
| Panel | #0D1010 | `bg-panel` / `bg-card` | Cards |
| Charcoal | #252A2A | `border-charcoal`, `bg-secondary` | Card edges, rails, hover |
| Warm white | #F3F0E8 | `text-foreground` | Text on black |
| Muted | #87938E | `text-muted-foreground` | Secondary text |
| Signal lime | #CCFF00 | `text-signal`, `primary` | **One signal per view** plus NN_ labels |
| Amber | #E7B14A | `text-caution` | Caution, stale, deadlines |
| Sun | #C2552A | `text-sun`, `destructive` | Risk/critical |
| Earth blue | #2378C4 | `text-earth` | Category, magnetopause |

- Type: IBM Plex Sans (`font-sans`) for headlines (full sentences, SemiBold) and body; JetBrains Mono (`font-mono`) for labels and telemetry.
- Labels: `.brand-label` = mono, uppercase, 0.12em tracking, lime, numbered to the page: `01_FIELD_MODEL`.
- Cards: `.hud-panel` (panel ground, charcoal border, 10px radius). Numbers: `font-mono tabular-nums` with units in muted text.
- Don't use `amber-400`-style Tailwind palettes for brand colours; use `caution`/`sun`/`earth`/`signal`.
- Scene encoding: closed field lines warm white→Earth blue; open amber→Sun; inner belt protons amber; outer belt electrons and aurora lime; magnetopause Earth blue; reconnection hot spot Sun.
- Note: GAU-9 mentions "Volt Green / Solar Red / Inter". The Brand Room supersedes that.

## 3D scene conventions (`frontend/src/components/scene/`)
- 1 scene unit = 1 Earth radius. The Sun is along +x. Scene axes = GSM `(x, z, −y)`: use `gsmToScene` from `@/lib/physics/geomagnetic`.
- `SpaceScene.tsx` owns the camera, controls, lights and layer composition. Layers are toggled via `LayerVisibility` (`components/types.ts`).
- `Magnetosphere.tsx` renders the traced field model: Shue magnetopause, bow shock, tail current sheet, field lines (one fat-line draw call), tracers and auroral ovals. It takes live `drivers` (Bz, By, Pdyn, Kp). Without them it falls back to the legacy normalised `compression`/`reconnectionStrength`.
- Additive-blended glow materials use `depthWrite={false}`. Memoise geometry/materials and update uniforms in `useFrame`. Never allocate per frame.
- Put physics and maths in `frontend/src/lib/**` with `node:test` coverage (`node --import tsx --test <file>`).

## UX checklist
- Fail closed (GAU-63/GAU-81): missing data renders "—" plus an amber status, never nominal defaults as live. Label live/stale/simulated state and data age.
- Canvas has `role="application"` and an `aria-label`, and keyboard controls work (arrows, +/−, R).
- Contrast AA on `bg-card`; never use colour alone for state; add a label or icon.
- Respect `prefers-reduced-motion` for non-essential animation.
- Mobile: check 375px width; panels stack (`lg:grid-cols-[1fr_320px]` pattern).

## Verify
1. `npx tsc --noEmit -p frontend/tsconfig.app.json`. Errors already exist in radiation utils, PublicDashboard and others, so report only new ones.
2. Run Vite on a free port (`npx vite --config frontend/vite.config.ts --port 8091 --strictPort`) and open `/heliophysics` (public) in the Browser pane. Wait ~5 s for the canvas, check console errors and take a screenshot.
3. Data hooks must only poll routes the viewer's role can use (`PUBLIC_READ_PATHS` for signed-out pages). CyberTiger counts 401/403s and auto-blocks the IP, so a 401 in the console is a bug, not noise.
4. `npm run build` before a PR.
