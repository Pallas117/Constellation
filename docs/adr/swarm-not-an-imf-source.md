# ADR: ESA Swarm is not an IMF source

- **Status:** Proposed (GAU-85), awaiting approval
- **Date:** 2026-10-12
- **Context:** GAU-51 removed Swarm `B_NEC` from the interplanetary-field (IMF) blend because it is in a local North-East-Centre frame. GAU-85 asked whether to bring it back after rotating it NEC → GEO → GSM.

## Decision

Swarm magnetometer data is **never blended into the IMF or solar-wind inputs**, rotated or not. The IMF comes from L1 monitors only (NOAA RTSW: DSCOVR, ACE, IMAP). Swarm is kept as **LEO and ionospheric context**: the adapter now records where each sample was taken (`position`) and its `|B|`.

## Why rotating is not enough

| | Swarm (LEO, ~450 km) | L1 monitor (~1.5 million km sunward) |
|---|---|---|
| What it measures | Earth's internal field, plus crustal, ionospheric (Sq, EEJ), field-aligned-current and magnetospheric contributions | The solar-wind magnetic field before it reaches Earth |
| Typical size | **~20,000–60,000 nT** | **~1–30 nT** |
| Relation to the IMF | None directly. Even after removing a main-field model (IGRF/CHAOS), the residual is mostly ionospheric and magnetospheric currents of tens to thousands of nT | It *is* the IMF |

A rotation changes only the coordinate frame, not what was measured. Removing a main-field model still leaves a residual whose errors (model error plus crustal and current-system fields) are larger than the whole IMF signal. Blending even 30% of it, as the old 0.7/0.3 blend did, would swamp Bz, the main driver of geomagnetic activity. That is exactly the "derived value presented as measured" failure GAU-63 forbids.

## What Swarm is good for (future work, not built)

- Field-aligned current and auroral-oval context, which are meaningful at high latitude: compare `B_NEC` against a main-field model along the track.
- Ionospheric disturbance indicators at the satellite's position, for LEO operators.
- Validation of the aurora-oval nowcast.

Each of these needs a main-field model (IGRF-14 or CHAOS-7), and any value derived from one must carry `derivedFrom` and a method (GAU-63/GAU-84 convention).

## Consequences

- `blendInputs` uses NOAA only for the IMF. The guard test "ingest: Swarm main-field values never leak into the IMF blend" (`backend/adapters/adapters.test.ts`) enforces this.
- `ESAReadout` carries `magneticFieldNec`, `position` (latitude, longitude, geocentric radius and altitude) and `fieldMagnitudeNt`, so it is usable as context without any implied frame conversion.
- GAU-85 can close once this ADR is approved.
