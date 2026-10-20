# Space Radiation Data Structure

The types, CSV parsers and utilities behind the radiation overlay in the heliophysics scene
(`components/scene/RadiationDataOverlay.tsx`, `RadiationDataOverlayLOD.tsx`, `SpaceScene.tsx`,
`pages/HeliophysicsDashboard.tsx`). The old radiation dashboard (its components, the
`useRadiationData` hooks and the NASA OMNI and SPENVIS clients) was removed in #74.

## Where it lives

```
frontend/src/lib/
├── types/radiation.ts              # Measurement, data point, time series and filter types
├── api/csv-parsers.ts              # CSV parsers for ERG/Arase, CSES and generic files
├── utils/radiation.ts              # Filtering, zones, time series, statistics, alert levels
├── utils/radiation-calculations.ts # Absorbed dose rate, flux conversion, source names
└── physics/stopping-power.ts       # NIST stopping powers in silicon (used by the dose rate)
```

## Type definitions (`lib/types/radiation.ts`)

### `RadiationMeasurement`
One radiation measurement:
- `timestamp`: ISO 8601 timestamp
- `particleFlux`: particles/(cm²·s·sr·MeV), or particles/(cm²·s)
- `altitude`: km
- `L_shell`: McIlwain L (dimensionless)
- `radiationZone`: optional zone derived from L-shell and altitude
- `latitude` / `longitude`: optional geographic coordinates (degrees)
- `particleType`: `'proton' | 'electron' | 'alpha' | 'heavy_ion'`
- `energyRange`: energy range in MeV
- `orbitType`: `'LEO' | 'MEO' | 'GEO'`
- `source`: data source identifier
- `metadata`: optional (instrument, quality, uncertainty)

### `RadiationDataFilter`
Query filter: time range, orbit and particle types, energy, L-shell and altitude ranges, data
sources, result limit.

The file also defines `RadiationDataPoint` (what the overlay draws), `RadiationTimeSeries`,
`RadiationDataResponse`, `RealTimeRadiationSnapshot`, `RadiationZone`, `AlertLevel` and
`EnergyRange`.

## CSV sources (`lib/api/csv-parsers.ts`)

- **ERG/Arase:** `parseERGAraseCSV(csvContent, options)`, or `loadRadiationCSV(fileOrUrl, 'erg-arase')`
- **CSES** (China Seismo-Electromagnetic Satellite): `parseCSESCSV(csvContent, options)`, or
  `loadRadiationCSV(fileOrUrl, 'cses')`
- **Other files:** `parseGenericRadiationCSV(csvContent, options)`

The parsers assume the standard column layouts; `CSVParserOptions` adjusts them.

## Utilities (`lib/utils/radiation.ts`)

### Filtering and zones
- `filterRadiationData(data, filter)`: filter measurements by a `RadiationDataFilter`
- `RADIATION_ZONES`, `getRadiationZone(measurement)`: zone from L-shell and altitude
- `toDataPoint(measurement)`: `RadiationMeasurement` → `RadiationDataPoint`

### Time series and statistics
- `createTimeSeries(measurements, orbitType?, particleType?, energyRange?)`
- `interpolateTimeSeries(timeSeries, intervalMs)`: fill missing points
- `calculateStatistics(measurements)`
- `groupByOrbitType(measurements)`, `groupByParticleType(measurements)`

### Alert levels
- `getAlertLevel(integralFluxPfu, particleType)`: alert level from integral flux in pfu.
  - Protons (≥10 MeV) use the NOAA S-scale (`noaaSolarRadiationStormLevel`: S1 ≥ 10 pfu up to S5 ≥ 10⁵ pfu).
  - Electrons (>2 MeV) use the SWPC 1000 pfu internal-charging alert (`SWPC_ELECTRON_ALERT_PFU`).
  - Returns `null` for alpha particles and heavy ions.
  - `ALERT_CHANNEL_MEV` gives each threshold's channel.
  - Sources: https://www.swpc.noaa.gov/noaa-scales-explanation and
    https://www.swpc.noaa.gov/products/goes-electron-flux
- `getAlertLevelFromMeasurements(measurements)`: the most severe level across species, from a
  lower bound on the integral flux of differential bins.

## Calculations (`lib/utils/radiation-calculations.ts`)

### Absorbed dose rate (Si)

`calculateDoseRate(flux, energyRange, particleType)` returns the absorbed dose rate in a thin,
unshielded silicon layer (Gy(Si)/s), or `null`:

```
Φ    = 4π × j × (Emax − Emin)          // cm⁻²·s⁻¹, isotropic; j in cm⁻²·s⁻¹·sr⁻¹·MeV⁻¹
S̄    = (1/ΔE) ∫ S(E) dE                 // MeV·cm²/g, NIST PSTAR/ESTAR (Si, electronic)
Ḋ    = 1.602e-10 × Φ × S̄                // Gy(Si)/s
```

- Stopping powers come from `lib/physics/stopping-power.ts` (NIST SRD 124, silicon).
- The bin uses the bin-averaged S̄ because j is taken as flat across the bin.
- Gy(Si) is the total-ionising-dose unit for electronics. It is not a tissue dose, and it is
  not in Sv: Sv needs tissue and a LET-dependent quality factor.
- Alpha particles and heavy ions return `null` (no stopping-power table here), as do empty bins
  and bins outside the table.
- `getDoseRateFromMeasurement(measurement)` applies it to one measurement.
- `unidirectionalToOmnidirectional` converts the flux.
- `formatSourceName` turns a source id into a label, e.g. `erg-arase` → "ERG/Arase".

There is no magnetic-field estimate here: the old `estimateMagneticField` left out μ₀/4π
(10⁷ too high) and was unused, so #114 removed it (GAU-151).

## Notes

- All timestamps are ISO 8601.
- Flux values are in particles/(cm²·s·sr·MeV) or particles/(cm²·s).
