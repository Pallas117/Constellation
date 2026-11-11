import { G4_DRIVERS, G4_PLASMA } from "@/lib/physics/live-drivers";

// Shown beside the "Simulate G4" scene (HeliophysicsDashboard) without claiming more than Gauss does
// (GAU-63, GAU-228): what the scenario is, and only what Gauss computes from it. The numbers are the
// scene's own drivers, so the two can't disagree.
export const SIMULATED_STORM_TEXT = `Simulated scenario: not live data and not a forecast.

The scene now runs on fixed severe-storm (G4) drivers instead of the measured L1 solar wind: IMF Bz ${G4_DRIVERS.bz} nT and By ${G4_DRIVERS.by} nT (GSM), speed ${G4_PLASMA.speed} km/s, density ${G4_PLASMA.density} cm⁻³, dynamic pressure ≈ ${G4_DRIVERS.pdyn} nPa, Kp ${G4_DRIVERS.kp}.

From these drivers Gauss computes the magnetopause stand-off distance (Shue et al. 1998; these drivers are outside the range that model was fitted to, so the result is extrapolated), whether geostationary orbit (6.6 Re) ends up outside the magnetopause, and the field lines drawn in the scene. The radiation points along the orbits are a stored example dataset, not a Gauss output.

Gauss gives no satellite impact assessment, drag estimate or confidence figure for this scenario. Choose "Back to live" to return to the measured drivers.`;
