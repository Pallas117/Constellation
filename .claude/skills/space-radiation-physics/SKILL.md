---
name: space-radiation-physics
description: Reference physics for the space radiation environment and its effects (trapped belts, SEPs, GCR, AE9/AP9, flux and dose units, LET, SEE/TID/DDD, shielding, NOAA S-scale) plus the known weak spots in Gauss radiation code. Use when writing, reviewing or visualising radiation flux, dose, alerts or belt intensity.
---

# Space radiation physics for Gauss

## Environment
- **Inner belt** (L ≈ 1.2–2.5): protons 10–400+ MeV, stable; source of the South Atlantic Anomaly (SAA) at LEO.
- **Outer belt** (L ≈ 3–7): electrons 0.1–10 MeV, highly dynamic with storms (dropout in main phase, enhancement in recovery). The slot region is L ≈ 2–3.
- **SEP events**: protons up to GeV, hours to days. GEO and polar LEO are exposed and low-inclination LEO is shielded by geomagnetic cutoff.
- **GCR**: low flux, high Z/E, anticorrelated with the solar cycle. It dominates SEE rates in quiet times.
- Reference models: AE9/AP9/SPM (current trapped-particle standard), CREME96 (SEE), SPENVIS. For operational alerts use NOAA SWPC GOES integral proton flux.

## Units — never mix
| Quantity | Unit |
|---|---|
| Differential flux j(E) | cm⁻²·s⁻¹·sr⁻¹·MeV⁻¹ |
| Integral flux J(>E) | cm⁻²·s⁻¹·sr⁻¹ (GOES: "pfu" = 1 cm⁻²·s⁻¹·sr⁻¹ for >10 MeV) |
| Omnidirectional flux | cm⁻²·s⁻¹ (≈ 4π × unidirectional for isotropic) |
| Absorbed dose | Gy = J/kg (state the material: Si or tissue). rad(Si) = 0.01 Gy |
| Dose equivalent | Sv = Gy × Q(LET), tissue only. Not meaningful for electronics |
| LET | MeV·cm²/mg |

Dose rate from flux (thin target, single species): Ḋ [Gy/s] = 1.602×10⁻¹⁰ × Φ [cm⁻²·s⁻¹] × S [MeV·cm²/g]. Here S is the mass stopping power in the target material, from NIST PSTAR/ESTAR. Multiplying flux by mean energy is **not** a dose.

## Effects on electronics
- **TID** (krad(Si)) from trapped protons and electrons: parametric drift. Mitigate with shielding and rad-hard parts.
- **DDD/NIEL** from protons: optoelectronics, solar cells, CCDs.
- **SEE** (SEU, SEL, SEFI, SEB) from GCR and SEP heavy ions and from proton nuclear reactions. Characterised by a Weibull cross-section vs LET.
- **Charging**: surface charging from 10–50 keV electrons, worst at GEO midnight–dawn during substorms. Internal/deep dielectric charging from >1 MeV electrons over days.

## NOAA S-scale (GOES ≥10 MeV integral protons, pfu)
S1 ≥10, S2 ≥10², S3 ≥10³, S4 ≥10⁴, S5 ≥10⁵.

## Known weak spots in this repo (check before trusting)
- `frontend/src/lib/utils/radiation-calculations.ts` `calculateDoseRate`: computes flux × mean energy × ad-hoc factor and labels it mSv/h. That is physically invalid (no stopping power, Sv applied to unspecified material, sr not integrated). Treat it as a relative intensity index until it is replaced.
- `getAlertLevel` in `radiation.ts`: thresholds need a cited source (S-scale for protons; for electrons, GOES >2 MeV 1000 pfu as the internal-charging alert).
- Belt visuals (`scene/VanAllenBelts.tsx`) are qualitative. They are now tilted with the dipole, but they do not yet respond to storm-time dropout or enhancement.

## Validation
Tests should use hand-checkable numbers: S-scale boundaries, the NIST stopping-power example (10 MeV p in Si, S ≈ 34.6 MeV·cm²/g), and a 1 pfu isotropic → 4π cm⁻²·s⁻¹ omni conversion.
