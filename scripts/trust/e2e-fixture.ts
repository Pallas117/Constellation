/**
 * Writes tests/e2e/fixtures/evidence-analysis.json: what the Evidence view's routes
 * (backend/trust/evidence-router.ts) answer for the synthetic sample log, so the browser test
 * (tests/e2e/evidence.spec.ts) shows real records and a real pack without a backend:
 *   node --import tsx scripts/trust/e2e-fixture.ts
 *
 * Run it again when the trust record or pack format changes. The software commit is pinned to
 * "e2e-fixture" (and the pack re-hashed) so the file does not change with every commit.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { packHashOf } from "../../backend/trust/evidence.js";
import { KEYRING_LABEL, MAX_LOG_BYTES, SIGN_ON_HOST } from "../../backend/trust/evidence-router.js";
import { checkPack } from "../../backend/trust/pack-check.js";
import { builtInMappings, pilotEvents, REPO_ROOT, runPilot, sampleLog } from "../../backend/trust/pilot-run.js";
import { keyStatus, loadKeyring, PUBLISHED_KEYRING_PATH } from "../../backend/trust/signing.js";

const keyring = loadKeyring(PUBLISHED_KEYRING_PATH);
const sample = sampleLog();
const mapping = builtInMappings().find((m) => m.id === sample.mappingId);
if (!mapping) throw new Error(`mapping ${sample.mappingId} is missing`);

const result = await runPilot({ log: Buffer.from(sample.text, "utf8"), mapping, eventId: sample.eventId });
const pack = { ...result.pack, inputs: { ...result.pack.inputs, software: { ...result.pack.inputs.software, commit: "e2e-fixture" } } };
pack.packHash = packHashOf(pack);

const name = `${pack.packId}.json`;
const verdict = (allowUnsigned: boolean) => ({ ...checkPack(pack, keyring, { subject: name, keyringLabel: KEYRING_LABEL, allowUnsigned }), keyring: KEYRING_LABEL });
const fixture = {
  options: {
    events: pilotEvents(),
    mappings: builtInMappings(),
    sample,
    maxLogBytes: MAX_LOG_BYTES,
    // Status as of the first key's start, so the file does not change with the date.
    keys: keyring.keys.map((k) => ({ keyId: k.keyId, purposes: k.purposes, status: keyStatus(k, Date.parse(k.validFrom)) })),
    keyring: KEYRING_LABEL,
    signOnHost: SIGN_ON_HOST,
  },
  analysis: { summary: result.summary, records: result.records, pack, signed: false, signOnHost: SIGN_ON_HOST },
  verify: { unsigned: verdict(false), integrity: verdict(true) },
};
if (!fixture.verify.integrity.ok) throw new Error(`the fixture pack does not verify: ${fixture.verify.integrity.problems.join("; ")}`);

const out = join(REPO_ROOT, "tests/e2e/fixtures/evidence-analysis.json");
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.error(`${out}: ${pack.records.length} records, pack hash ${pack.packHash}`);
