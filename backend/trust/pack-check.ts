/**
 * One check of an evidence pack, worded once: `npm run trust:verify` prints these lines and the
 * operator console's Evidence view shows the same ones (GAU-59), so a buyer reads the same
 * OK / FAILED text wherever the pack is checked.
 */
import { verifyEvidencePack, type EvidencePack } from "./evidence.js";
import { CURRENT_EVIDENCE_PDF_RENDERER, declaredEvidencePdfRenderer, EVIDENCE_PDF_RENDERERS, isEvidencePdfRenderer, renderEvidencePdf } from "./evidence-pdf.js";
import { verifyPackSignature, type Keyring } from "./signing.js";

export interface PackCheck {
  ok: boolean;
  /** Why the pack can't be relied on; empty when it can. */
  problems: string[];
  /** What the reader should know even when it can, e.g. that it is not signed. */
  notes: string[];
  /** What `trust:verify` prints, line by line. */
  lines: string[];
}

export const NOT_SIGNED_NOTE = "NOT SIGNED: integrity only. Nothing shows who made this pack; compare its pack hash with a copy you trust.";

/** The report `trust:verify` prints for a subject: `<subject>: OK. <detail>` or `<subject>: FAILED` and its problems, then the notes. */
export function checkLines(subject: string, problems: string[], notes: string[], okDetail: string): string[] {
  return [
    ...(problems.length ? [`${subject}: FAILED`, ...problems.map((p) => `  - ${p}`)] : [`${subject}: OK. ${okDetail}`]),
    ...notes.map((n) => `  NOTE: ${n}`),
  ];
}

export function checkPack(
  pack: EvidencePack,
  keyring: Keyring,
  options: {
    /** What the report calls the pack, e.g. its file name. */
    subject: string;
    /** What the report calls the keyring, e.g. its path. */
    keyringLabel: string;
    /** Check integrity only when the pack has no signature (it then passes with a NOTE). */
    allowUnsigned?: boolean;
    /** A PDF that must be exactly the rendering of this pack, by the renderer version it declares (none = 1). */
    pdf?: { bytes: Buffer; label: string };
    /** A pack hash held elsewhere that this pack must have. */
    expectedHash?: string;
  },
): PackCheck {
  const problems = verifyEvidencePack(pack);
  const notes: string[] = [];
  let signer = "";
  if (!pack?.signature && options.allowUnsigned) {
    notes.push(NOT_SIGNED_NOTE);
  } else if (pack && typeof pack === "object") {
    const check = verifyPackSignature(pack, keyring);
    problems.push(...check.problems);
    notes.push(...check.notes);
    if (check.key) signer = `; signed by key ${check.key.keyId} on ${pack.signature?.signedAt} (keyring ${options.keyringLabel})`;
  }
  const { pdf, expectedHash } = options;
  if (pdf && problems.length === 0) {
    // Render with the version the PDF declares, so PDFs issued by older Gauss versions still verify;
    // the byte comparison decides either way.
    const renderer = declaredEvidencePdfRenderer(pdf.bytes);
    if (!isEvidencePdfRenderer(renderer)) {
      problems.push(
        `${pdf.label} says it was made by PDF renderer version ${renderer}, which this Gauss version does not have (it has ${EVIDENCE_PDF_RENDERERS.join(", ")}); verify it with a newer Gauss`,
      );
    } else if (!renderEvidencePdf(pack, renderer).equals(pdf.bytes)) {
      problems.push(`${pdf.label} is not the rendering of this pack (PDF renderer version ${renderer})`);
    } else if (renderer < CURRENT_EVIDENCE_PDF_RENDERER) {
      notes.push(
        `${pdf.label} was made by an older Gauss (PDF renderer version ${renderer}) and matches that rendering${renderer === 1 ? '; it has no "What to do next" section' : ""}. Re-render it from the pack for the current version.`,
      );
    }
  }
  if (expectedHash && expectedHash !== pack.packHash) problems.push(`pack hash ${pack.packHash} is not the expected ${expectedHash}`);
  const okDetail = problems.length ? "" : `${pack.records.length} records, pack hash ${pack.packHash}${signer}${pdf ? `; ${pdf.label} matches` : ""}`;
  return { ok: problems.length === 0, problems, notes, lines: checkLines(options.subject, problems, notes, okDetail) };
}
