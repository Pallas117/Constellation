/**
 * Guard for the measurement freshness policy (GAU-212, audit finding F7): one table,
 * shared/policy/freshness.json, says how old each measured quantity may be, and no surface keeps
 * its own number, so one Kp cannot read fresh on one surface and stale on another.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FRESHNESS_POLICY, freshnessLabel, freshnessMin, freshnessMs, type FreshnessKey } from "../../shared/policy/freshness.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const KEYS = [
  "l1_solar_wind",
  "kp_estimated_1m",
  "kp_planetary_3h",
  "dst_kyoto",
  "goes_particles",
  "goes_xray",
  "noaa_scales",
  "esa_swarm_hapi",
  "mms_fgm_l2",
] as const satisfies readonly FreshnessKey[];

test("GAU-212: the freshness table has every key, each with a whole-minute bound and its reasons", () => {
  // The file itself, not the typed import, so an entry no code reads yet is checked too.
  const table = JSON.parse(readFileSync(path.join(ROOT, "shared/policy/freshness.json"), "utf8")) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(table).sort(), [...KEYS].sort());
  for (const [key, rule] of Object.entries(table)) {
    assert.deepEqual(Object.keys(rule).sort(), ["cadence", "maxAgeMin", "source", "why"], key);
    assert.ok(Number.isInteger(rule.maxAgeMin) && (rule.maxAgeMin as number) > 0, `${key}.maxAgeMin must be a positive whole number of minutes`);
    for (const field of ["cadence", "source", "why"]) {
      const text = rule[field];
      assert.ok(typeof text === "string" && text.trim() !== "", `${key}.${field} must be non-empty text`);
    }
  }
});

test("GAU-212: the accessors read the table", () => {
  for (const key of KEYS) {
    assert.equal(freshnessMin(key), FRESHNESS_POLICY[key].maxAgeMin);
    assert.equal(freshnessMs(key), freshnessMin(key) * 60_000);
    assert.match(freshnessLabel(key), /^\d+ (min|h)$/);
  }
});

// ---------------------------------------------------------------------------------------------
// Grep gate: no MAX_AGE / STALE / EXPIRY constant in the scanned code is a number of its own.

const SCAN_DIRS = ["backend", "frontend/src", "website/worker"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);
const CODE = /\.(?:[cm]?js|tsx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** `file:CONSTANT` pairs that keep a literal on purpose, each with the reason. */
const ALLOWED: Record<string, string> = {
  "backend/mesh/store.ts:MESH_STALE_MS": "mesh device-report staleness, not a measurement (out of scope)",
  "backend/mesh/store.ts:POSTURE_MAX_AGE_MS": "age of Argo's device security posture report (GAU-238), not a measurement (out of scope)",
  "frontend/src/components/MeshStatusPill.tsx:STALE_MS": "mesh device-report staleness, not a measurement (out of scope)",
  "frontend/src/lib/mesh-onboarding.ts:STALE_MS": "mesh device-report staleness, not a measurement (out of scope)",
  "frontend/src/hooks/useSpaceWeather.ts:STALENESS_RECHECK_MS": "how often the UI re-checks ages, not an age limit",
  "website/worker/calls.js:INDEX_MAX_AGE": "age of the cached calls index, not of a measurement (out of scope)",
};

/**
 * Comments are dropped first, so a number or a `;` in one doesn't count; a comment starts with
 * `//` or `/*` after whitespace, so the `//` in a URL string is left alone. Then DECLARATION
 * finds each `const|let|var NAME` whose NAME contains MAX_AGE, STALE or EXPIRY, skips an optional
 * `: Type`, and captures the initializer up to the first `;`, so a multi-line object literal is
 * read whole. String literals are blanked in the initializer (a policy key like "kp_planetary_3h"
 * holds a digit), and any digit left at the start of a word is a numeric literal (15, 60_000, 3.5).
 */
const COMMENT = /(^|\s)(?:\/\/.*$|\/\*[\s\S]*?\*\/)/gm;
const DECLARATION = /\b(?:const|let|var)\s+(\w*(?:MAX_AGE|STALE|EXPIRY)\w*)\s*(?::[^=]+)?=([^;]*)/g;
const STRING = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;
const NUMBER = /\b\d/;

/** Names of the matching constants in `source` whose initializer holds a numeric literal. */
function literalAges(source: string): string[] {
  const code = source.replace(COMMENT, "$1");
  return [...code.matchAll(DECLARATION)].filter((m) => NUMBER.test(m[2].replace(STRING, '""'))).map((m) => m[1]);
}

function codeFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name.startsWith(".") || SKIP_DIRS.has(entry.name) ? [] : codeFiles(rel);
    return CODE.test(entry.name) && !TEST_FILE.test(entry.name) ? [rel] : [];
  });
}

test("GAU-212: the gate catches a literal and passes the table", () => {
  assert.deepEqual(literalAges("export const FOO_MAX_AGE_MS = 15 * 60_000;"), ["FOO_MAX_AGE_MS"]);
  assert.deepEqual(literalAges("const STALE_AFTER_MIN = 3.5; // hours"), ["STALE_AFTER_MIN"]);
  assert.deepEqual(literalAges('export const MAX_AGE_MS: Record<string, number> = {\n  // GAU-112; GOES\n  a: freshnessMs("goes_xray"),\n  b: 2 * 3_600_000,\n};'), ["MAX_AGE_MS"]);
  assert.deepEqual(literalAges('export const KP_MAX_AGE_MS = freshnessMs("kp_planetary_3h"); // 6 h'), []);
  assert.deepEqual(literalAges('const DATA_EXPIRY_MS = freshnessMs("l1_solar_wind");\nconst URL = "https://x/1";'), []);
  assert.deepEqual(literalAges("export const NOAA_MAX_AGE_MS = LATEST_MAX_AGE_MS;"), []);
});

test("GAU-212: no measurement age limit is hard-coded outside shared/policy/freshness.json", () => {
  const found = SCAN_DIRS.flatMap(codeFiles).flatMap((file) => literalAges(readFileSync(path.join(ROOT, file), "utf8")).map((name) => `${file}:${name}`));
  const unexpected = found.filter((hit) => !(hit in ALLOWED));
  assert.deepEqual(unexpected, [], "derive these from shared/policy/freshness.json (freshnessMs / freshnessMin), or add them to ALLOWED with a reason");
  const unused = Object.keys(ALLOWED).filter((hit) => !found.includes(hit));
  assert.deepEqual(unused, [], "these ALLOWED entries no longer match anything: remove them");
});
