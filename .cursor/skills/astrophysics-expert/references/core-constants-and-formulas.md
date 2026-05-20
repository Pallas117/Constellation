# Core Constants and Formulas

Use this reference for fast, consistent astrophysical calculations.

## Physical Constants (SI)
- Speed of light: `c = 2.99792458e8 m s^-1`
- Gravitational constant: `G = 6.67430e-11 m^3 kg^-1 s^-2`
- Planck constant: `h = 6.62607015e-34 J s`
- Boltzmann constant: `k_B = 1.380649e-23 J K^-1`
- Stefan-Boltzmann constant: `sigma = 5.670374419e-8 W m^-2 K^-4`

## Astronomical Units
- Astronomical unit: `1 AU = 1.495978707e11 m`
- Parsec: `1 pc = 3.085677581e16 m`
- Light-year: `1 ly = 9.460730472e15 m`
- Solar mass: `M_sun = 1.98847e30 kg`
- Solar radius: `R_sun = 6.957e8 m`
- Solar luminosity: `L_sun = 3.828e26 W`

## Core Relations

### Radiation and Flux
- Inverse-square law: `F = L / (4 pi d^2)`
- Stefan-Boltzmann luminosity: `L = 4 pi R^2 sigma T^4`

### Magnitudes and Distance
- Distance modulus: `mu = m - M = 5 log10(d/10 pc)`
- Rearranged distance: `d(pc) = 10^((mu + 5)/5)`

### Orbital Mechanics
- Kepler (two-body, convenient units): `P(yr)^2 = a(AU)^3 / M_tot(M_sun)`
- Escape velocity: `v_esc = sqrt(2GM/R)`

### Relativity and Compact Objects
- Schwarzschild radius: `R_s = 2GM/c^2`

### Cosmology (Low-z Approximation)
- Recession speed for small redshift: `v ~ cz` for `z << 1`

## Typical Scales (Order of Magnitude)
- Sun-like star luminosity: `~1 L_sun`
- White dwarf radius: `~1e4 km`
- Neutron star radius: `~10-15 km`
- Stellar-mass black hole Schwarzschild radius: `~3 km * (M/M_sun)`
- Milky Way diameter: `~30 kpc`

## Usage Notes
- Prefer SI for calculations; present final answers in astrophysical units when helpful.
- State assumptions for albedo, inclination, metallicity, cosmology, and extinction when they affect interpretation.
- Report uncertainty if the input values are uncertain.
