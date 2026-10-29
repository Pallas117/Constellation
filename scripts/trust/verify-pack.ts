/**
 * Check an evidence pack (PR-04, GAU-60):
 *   npm run trust:verify -- pack.json [--pdf pack.pdf] [--hash <expected pack hash>]
 *
 * Recomputes every record hash, the hash chain and the pack hash, and checks the wording rules
 * and the row accounting. `--pdf` also checks the PDF is exactly the rendering of this pack;
 * `--hash` compares with a pack hash you hold from elsewhere (until packs are signed, GAU-67,
 * that copy is what ties the pack to its author). Exit 0 only when everything checks out.
 */
import { readFileSync } from "node:fs";
import { verifyEvidencePack, type EvidencePack } from "../../backend/trust/evidence.js";
import { renderEvidencePdf } from "../../backend/trust/evidence-pdf.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const packPath = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!packPath) {
  console.error("usage: npm run trust:verify -- <pack.json> [--pdf pack.pdf] [--hash <expected pack hash>]");
  process.exit(2);
}

const pack = JSON.parse(readFileSync(packPath, "utf8")) as EvidencePack;
const problems = verifyEvidencePack(pack);
const pdfPath = opt("--pdf");
if (pdfPath && problems.length === 0 && !renderEvidencePdf(pack).equals(readFileSync(pdfPath))) problems.push(`${pdfPath} is not the rendering of this pack`);
const expected = opt("--hash");
if (expected && expected !== pack.packHash) problems.push(`pack hash ${pack.packHash} is not the expected ${expected}`);

if (problems.length) {
  console.error(`${packPath}: FAILED`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`${packPath}: OK. ${pack.records.length} records, pack hash ${pack.packHash}${pdfPath ? `; ${pdfPath} matches` : ""}`);
