/**
 * Customer inference-log ingest (PR-03a, GAU-66): a customer's CSV, JSON or JSONL log, read
 * through a declarative per-customer column mapping, into trust-record requests (PR-01).
 *
 * Nothing is dropped silently. Every row either becomes a request carrying its provenance (the
 * file's SHA-256, its row number and the mapping's id and version), or is rejected with the
 * reasons: malformed, out of order for its spacecraft, or a duplicate of an earlier row. The
 * same bytes and the same mapping always give the same result.
 */
import { createHash } from "node:crypto";
import { parseTrustRequest, type IngestProvenance, type TrustRecordRequest } from "./record.js";

export const MAPPING_SCHEMA = "gauss.log-mapping/0.1";

/** How one customer's log columns become trust-record fields. Column names are matched exactly. */
export interface LogMapping {
  schema: typeof MAPPING_SCHEMA;
  id: string;
  version: string;
  format: "csv" | "json" | "jsonl";
  /** "iso" needs a zone (Z or ±hh:mm) unless `assumeUtc`; "unix-s" / "unix-ms" are epoch numbers. */
  timeFormat: "iso" | "unix-s" | "unix-ms";
  /** Only for zone-less ISO times the customer confirmed are UTC. */
  assumeUtc?: boolean;
  columns: {
    time: string;
    spacecraftId?: string;
    modelId?: string;
    processorProfileId?: string;
    /** One column (its value) or several (an object of them). */
    output?: string | string[];
    confidence?: string;
    latDeg?: string;
    lonDeg?: string;
    altKm?: string;
    tleLine1?: string;
    tleLine2?: string;
    /** Model artefact (GAU-245): format, SHA-256 of the ONNX file or TensorRT engine, runtime and its version. */
    modelFormat?: string;
    modelSha256?: string;
    runtime?: string;
    runtimeVersion?: string;
  };
  /** Values that are the same for the whole file, e.g. one file per spacecraft or per engine build. */
  constants?: {
    spacecraftId?: string;
    modelId?: string;
    processorProfileId?: string;
    modelFormat?: string;
    modelSha256?: string;
    runtime?: string;
    runtimeVersion?: string;
  };
  /**
   * When the processorProfileId column holds the log's own device name (e.g. "Jetson AGX Orin"),
   * this table turns it into a Gauss profile id. A device name not in the table rejects the row,
   * so a typo can't quietly leave a record without its profile.
   */
  processorProfiles?: Record<string, string>;
}

export interface IngestedRow {
  request: TrustRecordRequest & { ingest: IngestProvenance };
}

export interface IngestReport {
  file: { sha256: string; bytes: number; rows: number };
  mapping: { id: string; version: string };
  accepted: IngestedRow[];
  rejected: Array<{ row: number; errors: string[] }>;
}

/** Why a mapping can't be used, or an empty list. */
export function mappingProblems(m: unknown): string[] {
  const p: string[] = [];
  if (!m || typeof m !== "object") return ["mapping must be a JSON object"];
  const x = m as Partial<LogMapping>;
  if (x.schema !== MAPPING_SCHEMA) p.push(`schema must be "${MAPPING_SCHEMA}"`);
  if (!x.id || typeof x.id !== "string") p.push("id is required");
  if (!x.version || typeof x.version !== "string") p.push("version is required");
  if (!["csv", "json", "jsonl"].includes(x.format as string)) p.push("format must be csv, json or jsonl");
  if (!["iso", "unix-s", "unix-ms"].includes(x.timeFormat as string)) p.push("timeFormat must be iso, unix-s or unix-ms");
  const c = x.columns;
  if (!c || typeof c !== "object" || typeof c.time !== "string") p.push("columns.time is required");
  else {
    if (!c.spacecraftId && !x.constants?.spacecraftId) p.push("spacecraftId needs a column or a constant");
    if (!c.modelId && !x.constants?.modelId) p.push("modelId needs a column or a constant");
    const pos = [c.latDeg, c.lonDeg, c.altKm].filter(Boolean).length;
    if (pos !== 0 && pos !== 3) p.push("latDeg, lonDeg and altKm go together");
    if (Boolean(c.tleLine1) !== Boolean(c.tleLine2)) p.push("tleLine1 and tleLine2 go together");
    const k = x.constants ?? {};
    const artefact = ["modelFormat", "modelSha256", "runtime", "runtimeVersion"] as const;
    const has = (f: (typeof artefact)[number]) => Boolean(c[f] || k[f]);
    if (artefact.some(has) && !(has("modelFormat") && has("modelSha256"))) p.push("a model artefact needs modelFormat and modelSha256 (a column or a constant)");
    if (x.processorProfiles !== undefined) {
      const t = x.processorProfiles;
      if (!t || typeof t !== "object" || Array.isArray(t) || Object.values(t).some((v) => typeof v !== "string" || v.trim() === "")) {
        p.push("processorProfiles must map device names to profile ids");
      } else if (!c.processorProfileId) p.push("processorProfiles needs a processorProfileId column");
    }
  }
  return p;
}

/**
 * RFC 4180 CSV: comma-separated, fields optionally in double quotes with "" for a quote, CRLF or
 * LF line ends. Returns the rows, or the 0-based row where a quoted field never closes.
 */
export function parseCsv(text: string): { rows: string[][] } | { error: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") endField();
    else if (ch === "\n") endRow();
    else if (ch === "\r" && text[i + 1] === "\n") {
      endRow();
      i += 1;
    } else field += ch;
    i += 1;
  }
  if (quoted) return { error: `row ${rows.length}: a quoted field never closes` };
  if (field !== "" || row.length) endRow();
  return { rows };
}

function timeFrom(value: unknown, m: LogMapping): { iso: string } | { error: string } {
  if (m.timeFormat === "unix-s" || m.timeFormat === "unix-ms") {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(n)) return { error: `time "${String(value)}" is not a ${m.timeFormat} number` };
    return { iso: new Date(m.timeFormat === "unix-s" ? n * 1000 : n).toISOString() };
  }
  if (typeof value !== "string" || value.trim() === "") return { error: "time is empty" };
  const v = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return { error: `time "${v}" is not an ISO 8601 date and time` };
  const zoned = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v);
  if (!zoned && !m.assumeUtc) return { error: `time "${v}" has no time zone; set assumeUtc in the mapping only if the customer confirms UTC` };
  const ms = Date.parse(zoned ? v : `${v.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString() } : { error: `time "${v}" is not a valid ISO 8601 time` };
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);

/** One record (an object keyed by column name) into a request body, or its problems. */
function bodyFrom(rec: Record<string, unknown>, m: LogMapping): { body: Record<string, unknown> } | { errors: string[] } {
  const c = m.columns;
  const errors: string[] = [];
  const t = timeFrom(rec[c.time], m);
  if ("error" in t) errors.push(t.error);
  const body: Record<string, unknown> = {
    time: "iso" in t ? t.iso : undefined,
    spacecraftId: c.spacecraftId ? rec[c.spacecraftId] : m.constants?.spacecraftId,
    modelId: c.modelId ? rec[c.modelId] : m.constants?.modelId,
  };
  const profile = c.processorProfileId ? rec[c.processorProfileId] : m.constants?.processorProfileId;
  if (profile !== undefined && profile !== null && profile !== "") {
    if (m.processorProfiles && c.processorProfileId) {
      const mapped = Object.hasOwn(m.processorProfiles, String(profile)) ? m.processorProfiles[String(profile)] : undefined;
      if (mapped === undefined) errors.push(`device "${String(profile)}" is not in the mapping's processorProfiles table`);
      else body.processorProfileId = mapped;
    } else body.processorProfileId = profile;
  }
  const pick = (f: "modelFormat" | "modelSha256" | "runtime" | "runtimeVersion") => {
    const v = c[f] ? rec[c[f]] : m.constants?.[f];
    return v === undefined || v === "" ? null : v;
  };
  const [format, sha256, runtime, runtimeVersion] = [pick("modelFormat"), pick("modelSha256"), pick("runtime"), pick("runtimeVersion")];
  if (c.modelFormat || c.modelSha256 || m.constants?.modelFormat || m.constants?.modelSha256) {
    // A mapping that names an artefact needs it on every row: an empty cell is rejected by the
    // record's validation, not skipped. Formats match case-insensitively ("ONNX", "TensorRT").
    body.modelArtifact = { format: typeof format === "string" ? format.toLowerCase() : format, sha256, runtime, runtimeVersion };
  }
  if (Array.isArray(c.output)) body.output = Object.fromEntries(c.output.map((k) => [k, rec[k] ?? null]));
  else if (c.output) body.output = rec[c.output] ?? null;
  if (c.confidence && rec[c.confidence] !== undefined && rec[c.confidence] !== "") {
    const v = num(rec[c.confidence]);
    if (Number.isFinite(v)) body.confidence = v;
    else errors.push(`confidence "${String(rec[c.confidence])}" is not a number`);
  }
  if (c.latDeg && c.lonDeg && c.altKm) {
    const raw = [rec[c.latDeg], rec[c.lonDeg], rec[c.altKm]];
    if (raw.some((v) => v !== undefined && v !== "")) {
      const [latDeg, lonDeg, altKm] = raw.map(num);
      body.ephemeris = { latDeg, lonDeg, altKm };
    }
  }
  if (c.tleLine1 && c.tleLine2 && (rec[c.tleLine1] || rec[c.tleLine2])) body.tle = [rec[c.tleLine1], rec[c.tleLine2]];
  return errors.length ? { errors } : { body };
}

/** Records keyed by column name, with each one's 1-based row number, or a file-level error. */
function recordsFrom(text: string, m: LogMapping): { records: Array<{ row: number; rec: Record<string, unknown> | null; error?: string }> } | { error: string } {
  if (m.format === "csv") {
    const parsed = parseCsv(text);
    if ("error" in parsed) return { error: parsed.error };
    const [header, ...rest] = parsed.rows.filter((r) => !(r.length === 1 && r[0] === ""));
    if (!header) return { error: "the file is empty" };
    const used = [m.columns.time, m.columns.spacecraftId, m.columns.modelId, m.columns.processorProfileId, m.columns.confidence, m.columns.latDeg, m.columns.lonDeg, m.columns.altKm, m.columns.tleLine1, m.columns.tleLine2, m.columns.modelFormat, m.columns.modelSha256, m.columns.runtime, m.columns.runtimeVersion, ...(Array.isArray(m.columns.output) ? m.columns.output : [m.columns.output])].filter(
      (x): x is string => typeof x === "string",
    );
    const missing = used.filter((col) => !header.includes(col));
    if (missing.length) return { error: `the header has no column ${missing.map((x) => `"${x}"`).join(", ")} named in the mapping` };
    return {
      records: rest.map((cells, i) =>
        cells.length !== header.length
          ? { row: i + 1, rec: null, error: `has ${cells.length} fields, the header has ${header.length}` }
          : { row: i + 1, rec: Object.fromEntries(header.map((h, j) => [h, cells[j]])) },
      ),
    };
  }
  const lines = m.format === "jsonl" ? text.split(/\r?\n/).filter((l) => l.trim() !== "") : null;
  let items: unknown[];
  if (lines) {
    return {
      records: lines.map((line, i) => {
        try {
          const v: unknown = JSON.parse(line);
          return v && typeof v === "object" && !Array.isArray(v) ? { row: i + 1, rec: v as Record<string, unknown> } : { row: i + 1, rec: null, error: "is not a JSON object" };
        } catch {
          return { row: i + 1, rec: null, error: "is not valid JSON" };
        }
      }),
    };
  }
  try {
    const v: unknown = JSON.parse(text);
    if (!Array.isArray(v)) return { error: "a json-format log must be one JSON array" };
    items = v;
  } catch {
    return { error: "the file is not valid JSON" };
  }
  return {
    records: items.map((v, i) => (v && typeof v === "object" && !Array.isArray(v) ? { row: i + 1, rec: v as Record<string, unknown> } : { row: i + 1, rec: null, error: "is not a JSON object" })),
  };
}

/**
 * Ingest one log file. A file-level problem (bad mapping, unreadable file, missing columns)
 * throws with the reason; row-level problems are reported per row.
 */
export function ingestLog(bytes: Buffer, mapping: LogMapping): IngestReport {
  const problems = mappingProblems(mapping);
  if (problems.length) throw new Error(`Mapping not usable: ${problems.join("; ")}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const parsed = recordsFrom(bytes.toString("utf8"), mapping);
  if ("error" in parsed) throw new Error(`Log not readable: ${parsed.error}`);

  const accepted: IngestedRow[] = [];
  const rejected: IngestReport["rejected"] = [];
  const lastTime = new Map<string, { ms: number; row: number }>();
  const seen = new Map<string, number>();
  for (const { row, rec, error } of parsed.records) {
    if (!rec) {
      rejected.push({ row, errors: [`row ${error}`] });
      continue;
    }
    const b = bodyFrom(rec, mapping);
    if ("errors" in b) {
      rejected.push({ row, errors: b.errors });
      continue;
    }
    const r = parseTrustRequest(b.body);
    if ("errors" in r) {
      rejected.push({ row, errors: r.errors });
      continue;
    }
    const req = r.request;
    // Two engine builds of one model may run side by side, so the engine hash is part of the key.
    const engine = req.modelArtifact?.sha256 ?? "";
    const key = `${req.spacecraftId}\u0000${req.modelId}\u0000${engine}\u0000${req.time}`;
    const dup = seen.get(key);
    if (dup !== undefined) {
      rejected.push({ row, errors: [`duplicate of row ${dup} (same spacecraft, model${engine ? ", engine" : ""} and time)`] });
      continue;
    }
    const ms = Date.parse(req.time);
    const prev = lastTime.get(req.spacecraftId);
    if (prev && ms < prev.ms) {
      rejected.push({ row, errors: [`out of order: earlier than row ${prev.row} for spacecraft ${req.spacecraftId}`] });
      continue;
    }
    seen.set(key, row);
    lastTime.set(req.spacecraftId, { ms, row });
    accepted.push({ request: { ...req, ingest: { fileSha256: sha256, row, mappingId: mapping.id, mappingVersion: mapping.version } } });
  }
  return { file: { sha256, bytes: bytes.length, rows: parsed.records.length }, mapping: { id: mapping.id, version: mapping.version }, accepted, rejected };
}
