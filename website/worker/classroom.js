// Gauss for Education: the classroom, for anyone with active education access (and admins).
// A prototype lab pack: every lab uses public data or the site's own demos, and says where its numbers come from.
import { esc } from "./render.js";

const LABS = [
  {
    k: "LAB_01", title: "Storm levels from raw data",
    goal: "Turn raw readings into NOAA's storm levels, and decide what to show when a reading is missing.",
    data: "GOES ≥10 MeV integral proton flux and planetary Kp, from NOAA SWPC's public JSON, or this site's /api/space-weather.",
    steps: [
      "Radiation (S): S1 starts at 10 pfu, S2 at 100, S3 at 1,000, S4 at 10,000 and S5 at 100,000.",
      "Geomagnetic (G): G1 starts at Kp 5, rising one level per Kp step to G5 at Kp 9.",
      "Compare your levels with NOAA's published scales for the same hour.",
      "Make one reading stale. Should the level be S0, or unknown? Gauss shows unknown (S?), never zero.",
    ],
    source: "NOAA Space Weather Scales (swpc.noaa.gov/noaa-scales-explanation)",
  },
  {
    k: "LAB_02", title: "Field lines and the radiation belts",
    goal: "Use the dipole field-line equation from the landing page to place the belts and the aurora.",
    data: "The equation r = L cos²(latitude), with r in Earth radii.",
    steps: [
      "A line meets the ground where cos²(latitude) = 1/L. Show that L = 4.6 lands at about 62° magnetic latitude.",
      "Sketch the inner belt (mostly protons) and the outer belt (mostly energetic electrons), with the slot between them.",
      "Find the L range whose footpoints fall at 65–71°. Why does the aurora sit there?",
      "Say what a pure dipole gets wrong: the day side is compressed and the night side stretched.",
    ],
    source: "NASA Earth Observatory, \"Probing the Electric Space Around Earth\" (image 78985)",
  },
  {
    k: "LAB_03", title: "Which data can we trust?",
    goal: "Practise mission-data assurance on the synthetic replay.",
    data: "The replay demo on /gauss/ and the sample evidence report on /gauss/evidence/. Both are synthetic and labelled.",
    steps: [
      "Label each replay step nominal, degraded, abstain, unknown or blocked, and say why.",
      "Which effects follow S (bit errors), and which follow G (link gaps)?",
      "Write a one-paragraph evidence note for one flagged record, then compare it with the sample report.",
    ],
    source: "Gauss replay demo (synthetic)",
  },
  {
    k: "LAB_04", title: "Fault isolation on the ground",
    goal: "Treat a laptop's network like a spacecraft subsystem: detect, isolate, recover.",
    data: "Gauss Argo's fault classes: no connection, Wi-Fi sign-in page, DNS, dead proxy, blocked port, TLS interception, open Wi-Fi.",
    steps: [
      "For each fault, name the least invasive fix and how you would check that it worked.",
      "Which faults should never be fixed automatically, and why? (Hint: anything needing an administrator.)",
      "Design the alert rule: when should a person be told, and how often?",
    ],
    source: "Gauss Argo (/argo/)",
  },
];

export function renderClassroom() {
  const labs = LABS.map((l) =>
    `<li class="lab"><p class="label">${esc(l.k)}</p><h2>${esc(l.title)}</h2><p class="lead">${esc(l.goal)}</p>` +
    `<p class="m"><strong>Data:</strong> ${esc(l.data)}</p><ol class="lab-steps">${l.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` +
    `<p class="src">Source: ${esc(l.source)}</p></li>`).join("");
  return `<p class="k">00_CLASSROOM · GAUSS FOR EDUCATION</p><h1 id="hero-h">Classroom.</h1>` +
    `<p class="lead">Four labs to start. They use public data and this site's demos, so a class can run them without an install.</p>` +
    `<p class="note">Prototype lab pack. For teaching and non-commercial research, not for operating a spacecraft.</p>` +
    `<ol class="labs">${labs}</ol><p class="actions"><a class="btn ghost" href="/app/">Back to your workspace</a></p>`;
}
