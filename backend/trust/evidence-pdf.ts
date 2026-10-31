/**
 * The PDF view of an evidence pack (PR-04, GAU-60): what a customer QA lead, insurer or
 * regulator reads. The JSON pack is the record; this renders it without adding anything, and the
 * same pack always gives the same PDF bytes.
 */
import type { EvidencePack } from "./evidence.js";
import { A4, PdfPage, textWidth, wrap, writePdf, type FontName } from "./pdf.js";

const MARGIN = 42;
const WIDTH = A4.width - 2 * MARGIN;
const BOTTOM = 52;

interface Column {
  title: string;
  width: number;
  font?: FontName;
}
const RECORD_COLUMNS: Column[] = [
  { title: "Inference time (UTC)", width: 74 },
  { title: "Spacecraft", width: 60 },
  { title: "Model", width: 60 },
  { title: "Verdict", width: 74, font: "Helvetica-Bold" },
  { title: "S / G / R", width: 42 },
  { title: "SAA", width: 28 },
  { title: "Reasons", width: WIDTH - 74 - 60 - 60 - 74 - 42 - 28 },
];

const level = (f: { value: { label: string } | null }) => f.value?.label ?? "?";
const saa = (v: boolean | null) => (v === null ? "?" : v ? "yes" : "no");
const utc = (iso: string) => iso.replace("T", " ").replace(/\.\d{3}Z$|Z$/, "");

export function renderEvidencePdf(pack: EvidencePack): Buffer {
  const pages: PdfPage[] = [];
  let page = new PdfPage();
  pages.push(page);
  let y = A4.height - MARGIN;
  let repeatHeader: (() => void) | null = null;

  const newPage = () => {
    page = new PdfPage();
    pages.push(page);
    y = A4.height - MARGIN;
    repeatHeader?.();
  };
  const ensure = (h: number) => {
    if (y - h < BOTTOM) newPage();
  };
  const paragraph = (text: string, font: FontName = "Helvetica", size = 8.5, indent = 0, gray = 0.1) => {
    const lines = wrap(text, font, size, WIDTH - indent);
    for (const l of lines) {
      ensure(size + 3);
      page.text(MARGIN + indent, y - size, l, font, size, gray);
      y -= size + 3;
    }
  };
  const heading = (text: string) => {
    ensure(40);
    y -= 10;
    page.text(MARGIN, y - 11, text, "Helvetica-Bold", 11);
    y -= 15;
    page.line(MARGIN, y, MARGIN + WIDTH, y);
    y -= 6;
  };
  const keyValue = (key: string, value: string, font: FontName = "Helvetica") => {
    const keyWidth = 118;
    const lines = wrap(value, font, font === "Courier" ? 7.5 : 8.5, WIDTH - keyWidth);
    ensure(lines.length * 11.5);
    page.text(MARGIN, y - 8.5, key, "Helvetica", 8.5, 0.4);
    for (const l of lines) {
      page.text(MARGIN + keyWidth, y - 8.5, l, font, font === "Courier" ? 7.5 : 8.5);
      y -= 11.5;
    }
  };
  const table = (columns: Column[], rows: string[][], size = 7) => {
    const header = () => {
      page.rect(MARGIN, y - size - 6, WIDTH, size + 6);
      let x = MARGIN;
      for (const c of columns) {
        page.text(x + 2, y - size - 2, c.title, "Helvetica-Bold", size, 0.3);
        x += c.width;
      }
      y -= size + 8;
    };
    ensure(3 * (size + 8));
    repeatHeader = header;
    header();
    for (const row of rows) {
      const cells = row.map((cell, i) => wrap(cell, columns[i].font ?? "Helvetica", size, columns[i].width - 4));
      const h = Math.max(...cells.map((c) => c.length)) * (size + 2) + 3;
      ensure(h);
      let x = MARGIN;
      cells.forEach((lines, i) => {
        lines.forEach((l, j) => page.text(x + 2, y - size - j * (size + 2), l, columns[i].font ?? "Helvetica", size));
        x += columns[i].width;
      });
      y -= h;
      page.line(MARGIN, y + 1, MARGIN + WIDTH, y + 1, 0.88, 0.3);
    }
    repeatHeader = null;
  };

  // Title
  page.text(MARGIN, y - 18, "Gauss evidence pack", "Helvetica-Bold", 18);
  y -= 26;
  paragraph("Space-environment context for each inference in the window. Advisory. It describes the environment, not the spacecraft.", "Helvetica", 9, 0, 0.35);
  y -= 4;

  heading("Pack");
  keyValue("Pack ID", pack.packId, "Courier");
  keyValue("Analysis window (UTC)", `${utc(pack.window.from)} to ${utc(pack.window.to)}`);
  keyValue("Generated (UTC)", utc(pack.generatedAt));
  keyValue("Spacecraft", pack.scope.spacecraft.join(", ") || "none");
  keyValue("Models", pack.scope.models.join(", ") || "none");
  keyValue("Processor profiles", pack.scope.processorProfiles.join(", ") || "none given");
  keyValue("Schema", `${pack.schema} (records ${pack.inputs.software.trustRecordSchema})`);

  heading("Integrity");
  keyValue("Pack hash (SHA-256)", pack.packHash, "Courier");
  keyValue("Chain head", pack.chain.head, "Courier");
  keyValue("Previous pack", pack.inputs.previousPackHash ?? "none (first pack in this series)", pack.inputs.previousPackHash ? "Courier" : "Helvetica");
  if (pack.signature) {
    keyValue("Signature", `Ed25519, signed ${utc(pack.signature.signedAt)} UTC`);
    keyValue("Signing key", pack.signature.keyId, "Courier");
  } else {
    keyValue("Signature", "Not signed. Compare the pack hash with a copy you trust.");
  }
  keyValue("Verify", "npm run trust:verify -- <pack.json> --pdf <pack.pdf>", "Courier");

  heading("Inputs");
  const log = pack.inputs.log;
  if (log) {
    keyValue("Inference log (SHA-256)", log.fileSha256, "Courier");
    keyValue("Log size", `${log.bytes} bytes, ${log.rows} rows: ${pack.records.length} in this pack, ${log.rejected.length} not used (listed below)`);
    keyValue("Column mapping", `${log.mappingId} version ${log.mappingVersion}`);
  } else {
    keyValue("Inference log", "none: requests were submitted directly");
  }
  keyValue("Environment", pack.inputs.environment.source);
  if (pack.inputs.environment.archiveSha256) keyValue("Archive (SHA-256)", pack.inputs.environment.archiveSha256, "Courier");
  keyValue("Software", `${pack.inputs.software.name} ${pack.inputs.software.commit}, requirements ${pack.inputs.software.requirementsVersion}`);
  const p = pack.inputs.policy;
  keyValue(
    "Policy",
    `${p.id}: degraded context from S${p.degradedAtRadiation} or G${p.degradedAtGeomagnetic}; orbit context ${p.requireOrbitContext ? "required" : "not required"}`,
  );

  heading("Summary");
  const v = pack.summary.verdicts;
  keyValue("Verdicts", `${pack.summary.records} records: ${v.consistent} consistent, ${v["degraded-context"]} degraded context, ${v.unknown} unknown`);
  for (const s of pack.summary.bySpacecraft) {
    keyValue(s.spacecraftId, `${s.verdicts.consistent} consistent, ${s.verdicts["degraded-context"]} degraded context, ${s.verdicts.unknown} unknown`);
  }
  if (pack.summary.reasons.length) {
    y -= 4;
    table(
      [
        { title: "Reason", width: WIDTH - 60 },
        { title: "Records", width: 60 },
      ],
      pack.summary.reasons.map((r) => [r.reason, String(r.count)]),
      7.5,
    );
  }

  heading("Records");
  table(
    RECORD_COLUMNS,
    pack.records.map((r) => [
      utc(r.inference.time),
      r.inference.spacecraftId,
      r.inference.modelId,
      r.verdict.value,
      `${level(r.environment.radiation)} ${level(r.environment.geomagnetic)} ${level(r.environment.radioBlackout)}`,
      saa(r.orbit.saa.value),
      r.verdict.reasons.join("; "),
    ]),
  );

  if (log?.rejected.length) {
    heading("Log rows not used");
    table(
      [
        { title: "Row", width: 40 },
        { title: "Why", width: WIDTH - 40 },
      ],
      log.rejected.map((r) => [String(r.row), r.errors.join("; ")]),
      7.5,
    );
  }

  heading("Limitations");
  for (const l of pack.limitations) {
    const lines = wrap(l, "Helvetica", 8.5, WIDTH - 12);
    ensure(lines.length * 11.5 + 2);
    page.text(MARGIN + 2, y - 8.5, "•", "Helvetica", 8.5);
    for (const line of lines) {
      page.text(MARGIN + 12, y - 8.5, line, "Helvetica", 8.5);
      y -= 11.5;
    }
    y -= 2;
  }

  pages.forEach((pg, i) => {
    const footer = `Gauss evidence pack ${pack.packId} · pack hash ${pack.packHash.slice(0, 16)}…`;
    pg.line(MARGIN, 38, MARGIN + WIDTH, 38);
    pg.text(MARGIN, 26, footer, "Helvetica", 7, 0.45);
    const n = `Page ${i + 1} of ${pages.length}`;
    pg.text(MARGIN + WIDTH - textWidth(n, "Helvetica", 7), 26, n, "Helvetica", 7, 0.45);
  });
  return writePdf(pages, { title: `Gauss evidence pack ${pack.packId}`, created: pack.generatedAt, id: pack.packHash });
}
