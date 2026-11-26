/**
 * Check an evidence pack (PR-04, GAU-60) or a signed release file (PR-04a, GAU-67). Offline:
 *   npm run trust:verify -- pack.json [--pdf pack.pdf] [--keyring signing-keys.json] [--hash <expected pack hash>] [--allow-unsigned]
 *   npm run trust:verify -- --file <artifact> [--sig <artifact>.sig.json] [--keyring signing-keys.json]
 *
 * A pack: recomputes every record hash, the hash chain and the pack hash, checks the wording
 * rules and the row accounting, and checks the Ed25519 signature against the keyring (default:
 * the published backend/trust/signing-keys.json; a customer passes the copy Gauss gave them). An
 * unsigned pack fails unless --allow-unsigned, which checks integrity only. A pack signed before
 * its key was retired passes with a NOTE saying so; a revoked key fails. `--pdf` also checks the
 * PDF is exactly the rendering of this pack, by the renderer version the PDF declares (none = 1);
 * `--hash` compares with a pack hash held elsewhere.
 * A file: checks its detached signature (`trust:sign -- --file`). Exit 0 only when everything
 * checks out.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { EvidencePack } from "../../backend/trust/evidence.js";
import { checkLines, checkPack } from "../../backend/trust/pack-check.js";
import { loadKeyring, PUBLISHED_KEYRING_PATH, verifyFileSignature, type FileSignature, type Keyring } from "../../backend/trust/signing.js";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--pdf", "--keyring", "--hash", "--file", "--sig"]);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [packPath = ""] = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));
const filePath = opt("--file");
if (!packPath && !filePath) {
  console.error("usage: npm run trust:verify -- <pack.json> [--pdf pack.pdf] [--keyring keys.json] [--hash <expected pack hash>] [--allow-unsigned]");
  console.error("       npm run trust:verify -- --file <artifact> [--sig <artifact>.sig.json] [--keyring keys.json]");
  process.exit(2);
}

function report(subject: string, problems: string[], notes: string[], ok: string): never {
  print(checkLines(subject, problems, notes, ok), problems.length > 0);
}

/** The FAILED block goes to stderr; an OK line and every NOTE to stdout. */
function print(lines: string[], failed: boolean): never {
  for (const line of lines) (failed && !line.startsWith("  NOTE: ") ? console.error : console.log)(line);
  process.exit(failed ? 1 : 0);
}

const keyringPath = opt("--keyring") ?? PUBLISHED_KEYRING_PATH;
let keyring: Keyring;
try {
  keyring = loadKeyring(keyringPath);
} catch (e) {
  report(keyringPath, [(e as Error).message], [], "");
}

if (filePath) {
  const sigPath = opt("--sig") ?? `${filePath}.sig.json`;
  const sig = JSON.parse(readFileSync(sigPath, "utf8")) as FileSignature;
  const check = verifyFileSignature(readFileSync(filePath), basename(filePath), sig, keyring);
  report(filePath, check.problems, check.notes, `signed by key ${sig.keyId} on ${sig.signedAt} (keyring ${keyringPath}); SHA-256 ${sig.file?.sha256}`);
}

const pack = JSON.parse(readFileSync(packPath, "utf8")) as EvidencePack;
const pdfPath = opt("--pdf");
const check = checkPack(pack, keyring, {
  subject: packPath,
  keyringLabel: keyringPath,
  allowUnsigned: args.includes("--allow-unsigned"),
  pdf: pdfPath ? { bytes: readFileSync(pdfPath), label: pdfPath } : undefined,
  expectedHash: opt("--hash"),
});
print(check.lines, !check.ok);
