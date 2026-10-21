/**
 * Minimal, deterministic PDF 1.4 writer (GAU-60): text in the standard Helvetica, Helvetica-Bold
 * and Courier fonts, lines and filled rectangles, uncompressed content streams. No dependency,
 * and the same input always gives the same bytes, so a PDF can be rebuilt from stored inputs and
 * compared byte for byte.
 *
 * The standard-14 fonts are not embedded (every PDF reader carries them). Text is encoded in
 * WinAnsi; characters outside it are transliterated (≤ becomes <=) or replaced with "?".
 */

export type FontName = "Helvetica" | "Helvetica-Bold" | "Courier";

const FONT_KEY: Record<FontName, string> = { Helvetica: "F1", "Helvetica-Bold": "F2", Courier: "F3" };

/** Advance widths (1/1000 em) from Adobe's core-14 AFM files, for ASCII 32–126. */
const ascii = (...runs: Array<number | [number, number]>) => runs.flatMap((r) => (Array.isArray(r) ? new Array<number>(r[1]).fill(r[0]) : [r]));
export const HELVETICA_WIDTHS = ascii(
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, [556, 10],
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
);
export const HELVETICA_BOLD_WIDTHS = ascii(
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, [556, 10],
  333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
  389, 280, 389, 584,
);
/** WinAnsi bytes above 127 that this writer emits: [byte, Helvetica width, Helvetica-Bold width]. */
const HIGH: Array<[string, number, number, number]> = [
  ["…", 0x85, 1000, 1000], ["‘", 0x91, 222, 278], ["’", 0x92, 222, 278], ["“", 0x93, 333, 500], ["”", 0x94, 333, 500],
  ["•", 0x95, 350, 350], ["–", 0x96, 556, 556], ["—", 0x97, 1000, 1000], ["°", 0xb0, 400, 400], ["±", 0xb1, 584, 584],
  ["µ", 0xb5, 556, 611], ["·", 0xb7, 278, 278], ["×", 0xd7, 584, 584],
];
const HIGH_BYTE = new Map(HIGH.map(([c, b]) => [c, b]));
const HIGH_WIDTH = new Map(HIGH.map(([, b, w, wb]) => [b, [w, wb] as const]));
const TRANSLITERATE: Record<string, string> = { "≤": "<=", "≥": ">=", "≠": "!=", "→": "->", "←": "<-", "≈": "~", "−": "-", "✓": "ok", "✗": "x", " ": " " };

/** A string as WinAnsi byte values. */
export function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && code <= 126) out.push(code);
    else if (HIGH_BYTE.has(ch)) out.push(HIGH_BYTE.get(ch)!);
    else if (code >= 0xa1 && code <= 0xff) out.push(code); // Latin-1 letters and signs are the same bytes in WinAnsi
    else if (TRANSLITERATE[ch]) out.push(...TRANSLITERATE[ch].split("").map((c) => c.charCodeAt(0)));
    else out.push(63); // "?"
  }
  return out;
}

/** Width of `text` in points. */
export function textWidth(text: string, font: FontName, size: number): number {
  let units = 0;
  for (const b of winAnsi(text)) {
    if (font === "Courier") units += 600;
    else if (b <= 126) units += (font === "Helvetica" ? HELVETICA_WIDTHS : HELVETICA_BOLD_WIDTHS)[b - 32];
    else units += HIGH_WIDTH.get(b)?.[font === "Helvetica" ? 0 : 1] ?? 556;
  }
  return (units * size) / 1000;
}

/** Lines of at most `width` points, broken at spaces; a word longer than a line is split. */
export function wrap(text: string, font: FontName, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, font, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    let rest = word;
    while (textWidth(rest, font, size) > width) {
      let n = rest.length - 1;
      while (n > 1 && textWidth(rest.slice(0, n), font, size) > width) n -= 1;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

const num = (n: number) => String(Math.round(n * 100) / 100);
const literal = (text: string) =>
  `(${winAnsi(text)
    .map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b > 126 ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b)))
    .join("")})`;

export const A4 = { width: 595, height: 842 };

/** One page's drawing operations, in PDF user space (origin bottom left, points). */
export class PdfPage {
  readonly ops: string[] = [];

  text(x: number, y: number, text: string, font: FontName = "Helvetica", size = 9, gray = 0.1): void {
    this.ops.push(`BT ${num(gray)} g /${FONT_KEY[font]} ${num(size)} Tf ${num(x)} ${num(y)} Td ${literal(text)} Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, gray = 0.75, width = 0.5): void {
    this.ops.push(`${num(gray)} G ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, gray = 0.94): void {
    this.ops.push(`${num(gray)} g ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
  }
}

/** Serialise pages to PDF bytes. `id` (hex) becomes the file identifier; `created` is ISO UTC. */
export function writePdf(pages: PdfPage[], meta: { title: string; created: string; id: string }): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const fontIds = (["Helvetica", "Helvetica-Bold", "Courier"] as FontName[]).map((f) =>
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`),
  );
  const catalogId = add("");
  const pagesId = add("");
  const d = meta.created.replace(/[-:]/g, "").replace("T", "").slice(0, 14);
  const infoId = add(`<< /Title ${literal(meta.title)} /Producer (Gauss) /CreationDate (D:${d}Z) >>`);
  const kids: number[] = [];
  for (const page of pages) {
    const stream = page.ops.join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
          `/Resources << /Font << /F1 ${fontIds[0]} 0 R /F2 ${fontIds[1]} 0 R /F3 ${fontIds[2]} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1"), Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
  let offset = chunks.reduce((n, c) => n + c.length, 0);
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    offsets.push(offset);
    offset += chunk.length;
    chunks.push(chunk);
  });
  const id = meta.id.replace(/[^0-9a-f]/gi, "").slice(0, 32).padEnd(32, "0");
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}
