---
name: geomagnetic-em-physics
description: Electromagnetism and space-plasma reference for Gauss (geomagnetic frames GEO/GEI/GSE/GSM/SM, IGRF dipole, Shue magnetopause, field-line tracing, solar wind coupling, reconnection, MHD, GICs, spacecraft charging) and the repo's field-model code. Use when touching magnetic field models, frame transforms, the magnetosphere visualisation, MHD nowcast or reconnection metrics.
---

# Geomagnetic & EM physics for Gauss

## Frames
- **GEO**: Earth-fixed. **GEI**: inertial, x toward the vernal equinox; GEO = rot_z(GMST) · GEI.
- **GSE**: x Earth→Sun, z ecliptic north. **GSM**: x Earth→Sun, z = projection of the dipole north axis ⟂ x. GSE→GSM is a rotation about x.
- **SM**: z along the dipole, y ⟂ Sun. GSM→SM is a rotation about y by the dipole tilt ψ.
- Dipole tilt ψ: sin ψ = Q̂·Ŝ (dipole north pole · Sun direction). Range about ±34°, positive in northern summer.
- Backend transforms: `backend/physics/coordinates.ts` (`gseToGsm`, `geoToGsm`). Frontend: `frontend/src/lib/physics/geomagnetic.ts` (`dipoleTiltRad`, `gsmToScene`).

## Core relations
- Dipole: B = B₀/r³ [3(m̂·r̂)r̂ − m̂], B₀ ≈ 29 800 nT (IGRF-14 2025), m̂ toward geomagnetic south. Pole (2025) at 80.8°N, 72.7°W.
- Dipole field line: r = L cos²λ. Footpoint latitude λ₀ = arccos(√(1/L)).
- Dynamic pressure: P_dyn [nPa] = 1.6726×10⁻⁶ · n [cm⁻³] · v² [km/s] (protons; ×~1.16 for 4% He).
- **Shue 1998**: r₀ = (10.22 + 1.29 tanh(0.184(Bz + 8.14))) · P_dyn^(−1/6.6); α = (0.58 − 0.007 Bz)(1 + 0.024 ln P_dyn); r(θ) = r₀(2/(1+cosθ))^α.
- **Bow shock** standoff (Farris & Russell 1994): R_bs ≈ r₀ [1 + 1.1((γ−1)M² + 2)/((γ+1)M²)], about 1.3 r₀.
- **Coupling**: E_y = −v·Bz (mV/m = 10⁻³·km/s·nT). Newell 2007: dΦ/dt = v^(4/3) B_T^(2/3) sin^(8/3)(θ_c/2).
- Auroral oval equatorward edge ≈ 66° − 2.1·Kp MLAT (display heuristic; prefer OVATION Prime for operations).
- Polar-cap boundary moves equatorward as open flux grows (Dungey cycle).

## Repo field model (`frontend/src/lib/physics/geomagnetic.ts`)
- Tilted dipole + saturating uniform IMF (Dungey vacuum superposition) + tanh tail current sheet (north lobe +x, hinged at 10 Re), RK4 traced, clipped at the Shue magnetopause.
- Calibrated so that the polar-cap boundary is ~70° MLAT for Bz = −3 nT and ~60° for a G4 storm (Bz = −20, P = 15 nPa).
- **Qualitative**: it is not divergence-free in the −4 to −10 Re tail transition and has no ring current or Birkeland currents. For quantitative work use Tsyganenko T96/TS05 (e.g. via geopack) or MHD output.
- Tests: `node --import tsx --test frontend/src/lib/physics/geomagnetic.test.ts`. They check the dipole surface field, the L-shell apex, the Shue nominal r₀, seasonal tilt sign and that a storm opens more flux than quiet conditions.

## Space-weather effects to model
- **GICs**: driven by dB/dt and ground conductivity. Geoelectric field E = Z(ω)·H/μ₀ (plane-wave method).
- **Spacecraft charging**: see the radiation skill. Worst case is a GEO substorm injection.
- **Reconnection** (`backend/physics/reconnection.ts`): MMS tetrahedron curlometer J = (∇×B)/μ₀. Check the quality factor |∇·B|/|∇×B| < 0.3.

## Validation habits
Analytical checks first (equatorial surface |B| = B₀, polar 2B₀, L apex), then published values (Shue nominal ≈ 10.2 Re), then cross-model comparisons. State model validity ranges (Shue: −18 < Bz < 15 nT, 0.5 < P < 8.5 nPa; extrapolation beyond that should be flagged in the UI).
