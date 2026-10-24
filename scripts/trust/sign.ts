/**
 * Sign an evidence pack or a release file with a Gauss key (PR-04a, GAU-67):
 *   npm run trust:sign -- <pack.json> --sign-key <private key file> [--pdf pack.pdf] [--keyring <file>]
 *   npm run trust:sign -- --file <artifact> --sign-key <private key file> [--keyring <file>]
 *
 * A pack is checked, then signed in place; its pack hash does not change, and `--pdf` writes its
 * PDF again because the PDF shows the signature. A release file (an archive, a checksum list, an
 * SBOM) gets a detached signature next to it, `<artifact>.sig.json`. The key must be in the
 * keyring (default: the published backend/trust/signing-keys.json), current and meant for that
 * use; its file must be outside the repository and readable only by its owner. Every signature is
 * checked against the keyring before it is written.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidencePack } from "../../backend/trust/evidence.js";
import { renderEvidencePdf } from "../../backend/trust/evidence-pdf.js";
import { loadKeyring, loadSigningKey, PUBLISHED_KEYRING_PATH, signFile, signPack, verifyFileSignature, verifyPackSignature } from "../../backend/trust/signing.js";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--sign-key", "--pdf", "--keyring", "--file"]);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [packPath = ""] = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));
const filePath = opt("--file");
const keyPath = opt("--sign-key");
if ((!packPath && !filePath) || !keyPath) {
  console.error("usage: npm run trust:sign -- <pack.json> --sign-key <key file> [--pdf pack.pdf] [--keyring keys.json]");
  console.error("       npm run trust:sign -- --file <artifact> --sign-key <key file> [--keyring keys.json]");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
try {
  const keyring = loadKeyring(opt("--keyring") ?? PUBLISHED_KEYRING_PATH);
  const key = loadSigningKey(keyPath, root);
  if (filePath) {
    const bytes = readFileSync(filePath);
    const sig = signFile(bytes, basename(filePath), key, keyring);
    const check = verifyFileSignature(bytes, basename(filePath), sig, keyring);
    if (check.problems.length) throw new Error(`the new signature does not check out: ${check.problems.join("; ")}`);
    writeFileSync(`${filePath}.sig.json`, JSON.stringify(sig, null, 2) + "\n");
    console.error(`${filePath}: signed by key ${sig.keyId}; signature in ${filePath}.sig.json`);
  } else {
    const pack = signPack(JSON.parse(readFileSync(packPath, "utf8")) as EvidencePack, key, keyring);
    const check = verifyPackSignature(pack, keyring);
    if (check.problems.length) throw new Error(`the new signature does not check out: ${check.problems.join("; ")}`);
    writeFileSync(packPath, JSON.stringify(pack, null, 2) + "\n");
    const pdfPath = opt("--pdf");
    if (pdfPath) writeFileSync(pdfPath, renderEvidencePdf(pack));
    console.error(`${packPath}: signed by key ${pack.signature?.keyId}, pack hash ${pack.packHash}${pdfPath ? `; PDF ${pdfPath}` : ""}`);
  }
} catch (e) {
  console.error(`not signed: ${(e as Error).message}`);
  process.exit(1);
}
