/**
 * "Wire your logs": reads a customer's inference log in the browser, suggests the column mapping
 * (gauss.log-mapping/0.1) and previews which rows the real ingest would accept or reject.
 *
 * Nothing here is uploaded: the file is read, parsed and judged on the customer's machine. The
 * authoritative run is still `npm run trust:ingest` (backend/trust/ingest.ts), which also hashes
 * the file and records provenance; this module mirrors its row rules so the preview and the run
 * agree, and `log-wiring.test.ts` checks that against the backend on the shipped fixture.
 */

export const MAPPING_SCHEMA = "gauss.log-mapping/0.1";
/** Larger files are read by the command line tool, not the browser. */
export const MAX_BROWSER_BYTES = 25 * 1024 * 1024;

export type LogFormat = "csv" | "json" | "jsonl";
export type TimeFormat = "iso" | "unix-s" | "unix-ms";
export type Confidence = "high" | "medium" | "low";

export interface Record_ {
  row: number;
  rec: Record<string, unknown> | null;
  error?: string;
}
export interface ReadLog {
  format: LogFormat;
  headers: string[];
  records: Record_[];
}

export interface WiringMapping {
  schema: typeof MAPPING_SCHEMA;
  id: string;
  version: string;
  format: LogFormat;
  timeFormat: TimeFormat;
  assumeUtc?: boolean;
  columns: {
    time: string;
    spacecraftId?: string;
    modelId?: string;
    processorProfileId?: string;
    output?: string | string[];
    confidence?: string;
    latDeg?: string;
    lonDeg?: string;
    altKm?: string;
    tleLine1?: string;
    tleLine2?: string;
  };
  constants?: { spacecraftId?: string; modelId?: string; processorProfileId?: string };
}

/** What each field is for, in the order the wizard shows them. */
export const FIELDS = [
  { key: "time", label: "Inference time", required: true, hint: "When the model ran (ISO 8601 with a zone, or epoch seconds/milliseconds)." },
  { key: "spacecraftId", label: "Spacecraft", required: true, hint: "Which satellite. If the whole file is one satellite, type its name instead." },
  { key: "modelId", label: "Model", required: true, hint: "Which model or version produced the output." },
  { key: "output", label: "Output", required: false, hint: "What the model said, kept exactly as logged. Pick one or more columns." },
  { key: "confidence", label: "Confidence", required: false, hint: "The model's own score, 0 to 1." },
  { key: "processorProfileId", label: "Processor", required: false, hint: "Chip or board, e.g. jetson-orin-nx. Unlocks the upset-risk band when a cited profile exists." },
  { key: "latDeg", label: "Latitude", required: false, hint: "Position at inference time. Latitude, longitude and altitude go together." },
  { key: "lonDeg", label: "Longitude", required: false, hint: "Degrees, −180 to 360." },
  { key: "altKm", label: "Altitude (km)", required: false, hint: "100 to 60,000 km." },
  { key: "tleLine1", label: "TLE line 1", required: false, hint: "Use instead of a position; Gauss propagates it. Both lines together." },
  { key: "tleLine2", label: "TLE line 2", required: false, hint: "" },
] as const;
export type FieldKey = (typeof FIELDS)[number]["key"];

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

export function detectFormat(fileName: string, text: string): LogFormat {
  const name = fileName.toLowerCase();
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson")) return "jsonl";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".csv")) return "csv";
  const first = text.trimStart()[0];
  if (first === "[") return "json";
  if (first === "{") return "jsonl";
  return "csv";
}

/** RFC 4180 CSV (comma, optional double quotes, CRLF or LF). Mirrors backend parseCsv. */
export function parseCsv(text: string): { rows: string[][] } | { error: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") endField();
    else if (ch === "\n") endRow();
    else if (ch === "\r" && text[i + 1] === "\n") {
      endRow();
      i++;
    } else field += ch;
  }
  if (quoted) return { error: `row ${rows.length}: a quoted field never closes` };
  if (field !== "" || row.length) endRow();
  return { rows };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Records keyed by column name with 1-based row numbers, or a file-level problem in plain words. */
export function readLog(text: string, format: LogFormat): ReadLog | { error: string } {
  const bom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (format === "csv") {
    const parsed = parseCsv(bom);
    if ("error" in parsed) return { error: parsed.error };
    const [header, ...rest] = parsed.rows.filter((r) => !(r.length === 1 && r[0] === ""));
    if (!header) return { error: "The file is empty." };
    return {
      format,
      headers: header.map((h) => h.trim()),
      records: rest.map((cells, i) =>
        cells.length !== header.length
          ? { row: i + 1, rec: null, error: `has ${cells.length} fields, the header has ${header.length}` }
          : { row: i + 1, rec: Object.fromEntries(header.map((h, j) => [h.trim(), cells[j]])) },
      ),
    };
  }
  let items: Array<{ value: unknown; bad?: string }>;
  if (format === "jsonl") {
    items = bom
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((line) => {
        try {
          return { value: JSON.parse(line) as unknown };
        } catch {
          return { value: null, bad: "is not valid JSON" };
        }
      });
  } else {
    try {
      const v: unknown = JSON.parse(bom);
      if (!Array.isArray(v)) return { error: "A .json log must be one JSON array of objects." };
      items = v.map((value) => ({ value }));
    } catch {
      return { error: "The file is not valid JSON." };
    }
  }
  if (items.length === 0) return { error: "The file is empty." };
  const records: Record_[] = items.map((it, i) =>
    it.bad ? { row: i + 1, rec: null, error: it.bad } : isObject(it.value) ? { row: i + 1, rec: it.value } : { row: i + 1, rec: null, error: "is not a JSON object" },
  );
  const headers: string[] = [];
  for (const r of records.slice(0, 200)) for (const k of Object.keys(r.rec ?? {})) if (!headers.includes(k)) headers.push(k);
  return { format, headers, records };
}

// ---------------------------------------------------------------------------------------
// Suggesting a mapping
// ---------------------------------------------------------------------------------------

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const SYNONYMS: Record<Exclude<FieldKey, "output">, string[]> & { output: string[] } = {
  time: ["time", "timestamp", "inference_time", "datetime", "date_time", "utc", "ts", "epoch", "observation_time", "event_time", "t"],
  spacecraftId: ["spacecraft_id", "spacecraft", "satellite", "sat", "sat_id", "satellite_id", "sc", "norad", "norad_id", "platform", "asset"],
  modelId: ["model_id", "model", "model_name", "model_version", "network", "net"],
  output: ["output", "label", "class", "prediction", "pred", "result", "detection", "category"],
  confidence: ["confidence", "score", "conf", "probability", "prob"],
  processorProfileId: ["processor_profile_id", "processor", "processor_profile", "chip", "hardware", "board", "device"],
  latDeg: ["lat_deg", "latitude", "lat"],
  lonDeg: ["lon_deg", "longitude", "lon", "lng"],
  altKm: ["alt_km", "altitude_km", "altitude", "alt", "height_km"],
  tleLine1: ["tle_line1", "tle_line_1", "tle1", "line1", "tle_1"],
  tleLine2: ["tle_line2", "tle_line_2", "tle2", "line2", "tle_2"],
};

const sample = (records: Record_[], col: string, n = 50) => {
  const out: unknown[] = [];
  for (const r of records) {
    const v = r.rec?.[col];
    if (v !== undefined && v !== "" && v !== null) out.push(v);
    if (out.length >= n) break;
  }
  return out;
};
const numeric = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ZONED = /([zZ]|[+-]\d{2}:?\d{2})$/;

/** Real logs have a few bad rows, so a column "looks like" something when most of its values do. */
const MOSTLY = 0.8;
const mostly = (values: unknown[], test: (v: unknown) => boolean) => values.length > 0 && values.filter(test).length / values.length >= MOSTLY;

/** How a column of time values is written, or null when it is neither ISO nor epoch numbers. */
export function sniffTime(values: unknown[]): { timeFormat: TimeFormat; assumeUtc: boolean } | null {
  if (values.length === 0) return null;
  const isoOk = (v: unknown) => typeof v === "string" && ISO.test(v.trim());
  if (mostly(values, isoOk)) {
    // Suggest UTC only when none of the readable times carries a zone; a mix is left to the preview.
    return { timeFormat: "iso", assumeUtc: values.filter(isoOk).every((v) => !ZONED.test(String(v).trim())) };
  }
  const n = (v: unknown) => numeric(v);
  if (mostly(values, (v) => Number.isFinite(n(v)) && n(v) > 1e11)) return { timeFormat: "unix-ms", assumeUtc: false };
  if (mostly(values, (v) => Number.isFinite(n(v)) && n(v) > 1e8 && n(v) <= 1e11)) return { timeFormat: "unix-s", assumeUtc: false };
  return null;
}

export interface Suggestion {
  columns: Partial<Record<FieldKey, string | string[]>>;
  confidence: Partial<Record<FieldKey, Confidence>>;
  timeFormat: TimeFormat;
  /** Zone-less ISO times: the customer must confirm UTC before the mapping is usable. */
  needsUtcConfirmation: boolean;
  notes: string[];
}

export function suggestMapping(headers: string[], records: Record_[]): Suggestion {
  const taken = new Set<string>();
  const columns: Suggestion["columns"] = {};
  const confidence: Suggestion["confidence"] = {};
  const notes: string[] = [];
  const normed = headers.map((h) => ({ h, n: norm(h) }));

  const pick = (key: FieldKey, ok: (col: string) => boolean = () => true): string | undefined => {
    const words = SYNONYMS[key];
    for (const w of words) {
      const hit = normed.find((x) => x.n === w && !taken.has(x.h) && ok(x.h));
      if (hit) {
        taken.add(hit.h);
        confidence[key] = "high";
        return hit.h;
      }
    }
    for (const w of words.filter((x) => x.length > 3)) {
      const hit = normed.find((x) => (x.n.includes(w) || w.includes(x.n)) && x.n.length > 2 && !taken.has(x.h) && ok(x.h));
      if (hit) {
        taken.add(hit.h);
        confidence[key] = "medium";
        return hit.h;
      }
    }
    return undefined;
  };

  const time = pick("time", (c) => sniffTime(sample(records, c)) !== null);
  if (time) columns.time = time;
  const sniffed = time ? sniffTime(sample(records, time)) : null;
  // Fall back to any column whose values read as ISO times, so an oddly named column is still found.
  if (!time) {
    const any = headers.find((h) => !taken.has(h) && sniffTime(sample(records, h))?.timeFormat === "iso");
    if (any) {
      taken.add(any);
      columns.time = any;
      confidence.time = "low";
      notes.push(`"${any}" looks like times, but its name doesn't say so. Check it.`);
    }
  }
  const timeInfo = columns.time ? sniffTime(sample(records, columns.time as string)) : sniffed;

  for (const k of ["spacecraftId", "modelId", "processorProfileId"] as const) {
    const c = pick(k);
    if (c) columns[k] = c;
  }
  const out = pick("output");
  if (out) columns.output = out;
  const conf = pick("confidence", (c) => {
    return mostly(sample(records, c), (v) => Number.isFinite(numeric(v)) && numeric(v) >= 0 && numeric(v) <= 1);
  });
  if (conf) columns.confidence = conf;

  const lat = pick("latDeg");
  const lon = pick("lonDeg");
  const alt = pick("altKm");
  if (lat && lon && alt) Object.assign(columns, { latDeg: lat, lonDeg: lon, altKm: alt });
  else if (lat || lon || alt) notes.push("Found only some of latitude, longitude and altitude. They go together, so none were mapped.");
  const t1 = pick("tleLine1");
  const t2 = pick("tleLine2");
  if (t1 && t2) Object.assign(columns, { tleLine1: t1, tleLine2: t2 });

  if (!columns.time) notes.push("No column looks like inference times. Pick one by hand.");
  if (!columns.spacecraftId) notes.push("No spacecraft column. If the file is one satellite, type its name.");
  if (!columns.modelId) notes.push("No model column. If the file is one model, type its name.");
  return {
    columns,
    confidence,
    timeFormat: timeInfo?.timeFormat ?? "iso",
    needsUtcConfirmation: timeInfo?.timeFormat === "iso" && timeInfo.assumeUtc,
    notes,
  };
}

// ---------------------------------------------------------------------------------------
// Mapping check and preview
// ---------------------------------------------------------------------------------------

/** Why the mapping can't be used yet, in plain words, or an empty list. Mirrors backend mappingProblems. */
export function wiringProblems(m: WiringMapping, headers: string[]): string[] {
  const p: string[] = [];
  const c = m.columns;
  if (!c.time) p.push("Choose the column that holds the inference time.");
  if (!c.spacecraftId && !m.constants?.spacecraftId) p.push("Choose the spacecraft column, or type the spacecraft name.");
  if (!c.modelId && !m.constants?.modelId) p.push("Choose the model column, or type the model name.");
  const pos = [c.latDeg, c.lonDeg, c.altKm].filter(Boolean).length;
  if (pos !== 0 && pos !== 3) p.push("Latitude, longitude and altitude go together: set all three or none.");
  if (Boolean(c.tleLine1) !== Boolean(c.tleLine2)) p.push("The two TLE lines go together: set both or neither.");
  const used = [c.time, c.spacecraftId, c.modelId, c.processorProfileId, c.confidence, c.latDeg, c.lonDeg, c.altKm, c.tleLine1, c.tleLine2, ...(Array.isArray(c.output) ? c.output : [c.output])].filter((x): x is string => typeof x === "string" && x !== "");
  const missing = used.filter((col) => !headers.includes(col));
  if (missing.length) p.push(`The file has no column ${missing.map((x) => `"${x}"`).join(", ")}.`);
  return p;
}

function timeIso(value: unknown, m: WiringMapping): { iso: string } | { error: string } {
  if (m.timeFormat !== "iso") {
    const n = numeric(value);
    if (!Number.isFinite(n)) return { error: `time "${String(value)}" is not a ${m.timeFormat} number` };
    const d = new Date(m.timeFormat === "unix-s" ? n * 1000 : n);
    return Number.isFinite(d.getTime()) ? { iso: d.toISOString() } : { error: `time "${String(value)}" is out of range` };
  }
  if (typeof value !== "string" || value.trim() === "") return { error: "time is empty" };
  const v = value.trim();
  if (!ISO.test(v)) return { error: `time "${v}" is not an ISO 8601 date and time` };
  const zoned = ZONED.test(v);
  if (!zoned && !m.assumeUtc) return { error: `time "${v}" has no time zone; set assumeUtc in the mapping only if the customer confirms UTC` };
  const ms = Date.parse(zoned ? v : `${v.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString() } : { error: `time "${v}" is not a valid time` };
}

const goodId = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 128;

export interface Preview {
  rows: number;
  accepted: number;
  rejected: Array<{ row: number; errors: string[] }>;
  /** The first accepted rows as the records Gauss would build, for a look before running. */
  samples: Array<{ row: number; time: string; spacecraftId: string; modelId: string; confidence: number | null; hasPosition: boolean }>;
  /** Rejection reasons grouped, most common first: "no time zone ×12". */
  reasons: Array<{ reason: string; count: number }>;
}

/** Judge every row the way the real ingest does. Call only when `wiringProblems` is empty. */
export function previewLog(records: Record_[], m: WiringMapping): Preview {
  const c = m.columns;
  const rejected: Preview["rejected"] = [];
  const samples: Preview["samples"] = [];
  const lastTime = new Map<string, { ms: number; row: number }>();
  const seen = new Map<string, number>();
  let accepted = 0;
  for (const { row, rec, error } of records) {
    if (!rec) {
      rejected.push({ row, errors: [`row ${error}`] });
      continue;
    }
    const errors: string[] = [];
    const t = timeIso(rec[c.time], m);
    if ("error" in t) errors.push(t.error);
    const sc = c.spacecraftId ? rec[c.spacecraftId] : m.constants?.spacecraftId;
    const md = c.modelId ? rec[c.modelId] : m.constants?.modelId;
    if (!goodId(sc)) errors.push("spacecraftId must be 1–128 characters");
    if (!goodId(md)) errors.push("modelId must be 1–128 characters");
    const profile = c.processorProfileId ? rec[c.processorProfileId] : m.constants?.processorProfileId;
    if (profile !== undefined && profile !== "" && profile !== null && !goodId(profile)) errors.push("processorProfileId must be 1–128 characters");
    let conf: number | null = null;
    if (c.confidence && rec[c.confidence] !== undefined && rec[c.confidence] !== "") {
      const v = numeric(rec[c.confidence]);
      if (!Number.isFinite(v)) errors.push(`confidence "${String(rec[c.confidence])}" is not a number`);
      else if (v < 0 || v > 1) errors.push("confidence must be a number from 0 to 1");
      else conf = v;
    }
    let hasPosition = false;
    if (c.latDeg && c.lonDeg && c.altKm) {
      const raw = [rec[c.latDeg], rec[c.lonDeg], rec[c.altKm]];
      if (raw.some((v) => v !== undefined && v !== "")) {
        const [lat, lon, alt] = raw.map(numeric);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.push("ephemeris: latitude must be −90 to 90 degrees");
        else if (!Number.isFinite(lon) || lon < -180 || lon > 360) errors.push("ephemeris: longitude must be −180 to 360 degrees");
        else if (!Number.isFinite(alt) || alt < 100 || alt > 60_000) errors.push("ephemeris: altitude must be 100 to 60,000 km");
        else hasPosition = true;
      }
    }
    if (c.tleLine1 && c.tleLine2 && (rec[c.tleLine1] || rec[c.tleLine2])) {
      if (!rec[c.tleLine1] || !rec[c.tleLine2]) errors.push("tle: tle must be two lines");
      else hasPosition = true; // line checksums are checked by the full run
    }
    if (c.output && !Array.isArray(c.output) && JSON.stringify(rec[c.output] ?? null).length > 4096) errors.push("output must be JSON of at most 4096 bytes");
    if (errors.length || "error" in t) {
      rejected.push({ row, errors });
      continue;
    }
    const time = (t as { iso: string }).iso;
    const key = `${(sc as string).trim()}\u0000${(md as string).trim()}\u0000${time}`;
    const dup = seen.get(key);
    if (dup !== undefined) {
      rejected.push({ row, errors: [`duplicate of row ${dup} (same spacecraft, model and time)`] });
      continue;
    }
    const ms = Date.parse(time);
    const prev = lastTime.get((sc as string).trim());
    if (prev && ms < prev.ms) {
      rejected.push({ row, errors: [`out of order: earlier than row ${prev.row} for spacecraft ${(sc as string).trim()}`] });
      continue;
    }
    seen.set(key, row);
    lastTime.set((sc as string).trim(), { ms, row });
    accepted++;
    if (samples.length < 5) samples.push({ row, time, spacecraftId: (sc as string).trim(), modelId: (md as string).trim(), confidence: conf, hasPosition });
  }
  const tally = new Map<string, number>();
  for (const r of rejected) {
    for (const e of r.errors) {
      const reason = e.replace(/"[^"]*"/g, "…").replace(/row \d+/g, "row N").replace(/\bhas \d+ fields, the header has \d+/, "has the wrong number of fields");
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
  }
  return {
    rows: records.length,
    accepted,
    rejected,
    samples,
    reasons: [...tally].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

/** The mapping file for the command line, from the wizard's choices. */
export function buildMapping(args: {
  format: LogFormat;
  timeFormat: TimeFormat;
  assumeUtc: boolean;
  columns: Partial<Record<FieldKey, string | string[]>>;
  constants: { spacecraftId?: string; modelId?: string; processorProfileId?: string };
  id: string;
}): WiringMapping {
  const cols: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(args.columns)) {
    if (Array.isArray(v) ? v.length > 0 : v) cols[k] = v as string | string[];
  }
  const constants = Object.fromEntries(Object.entries(args.constants).filter(([, v]) => v && v.trim() !== "").map(([k, v]) => [k, (v as string).trim()]));
  return {
    schema: MAPPING_SCHEMA,
    id: args.id,
    version: "0.1.0",
    format: args.format,
    timeFormat: args.timeFormat,
    ...(args.timeFormat === "iso" && args.assumeUtc ? { assumeUtc: true } : {}),
    columns: cols as WiringMapping["columns"],
    ...(Object.keys(constants).length ? { constants } : {}),
  };
}

/** A safe mapping id from a file or customer name: lower-case letters, digits and dashes. */
export function mappingId(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return base || "customer-log";
}

/** The command to run once the mapping is saved next to the log. Paths are quoted for the shell. */
export function ingestCommand(logName: string, mappingName: string, event = "jan-2026"): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `npm run trust:ingest -- ${q(logName)} ${q(mappingName)} --replay ${event}`;
}

/** A small made-up log for trying the wizard with no data of your own. Two rows are deliberately bad. */
export const SAMPLE_LOG_CSV = [
  "inference_time,sat,model,label,score,lat,lon,alt_km",
  "2026-01-19T02:10:00Z,DEMO-SAT-1,cloudmask-v3.2,clear,0.94,12.4,101.7,525",
  "2026-01-19T03:00:00Z,DEMO-SAT-1,cloudmask-v3.2,cloud,0.81,14.9,104.2,525",
  "2026-01-19T03:00:00Z,DEMO-SAT-1,cloudmask-v3.2,cloud,0.81,14.9,104.2,525",
  "2026-01-19T04:50:30Z,DEMO-SAT-1,cloudmask-v3.2,cloud,0.88,,,",
  "2026-01-19T05:00:00,DEMO-SAT-1,cloudmask-v3.2,cloud,0.80,,,",
  "2026-01-19T05:10:00Z,DEMO-SAT-2,ship-detect-v1.4,vessel,0.91,-3.1,71.0,540",
  "2026-01-19T05:20:00Z,DEMO-SAT-2,ship-detect-v1.4,vessel,0.77,-1.2,75.3,540",
].join("\n");

/** Rejected rows as a CSV the customer can open and fix: row number, reasons, and the original cells. */
export function rejectedCsv(preview: Preview, records: Record_[], headers: string[]): string {
  const q = (v: unknown) => {
    const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const byRow = new Map(records.map((r) => [r.row, r]));
  const lines = [["row", "why", ...headers].map(q).join(",")];
  for (const r of preview.rejected) {
    const rec = byRow.get(r.row)?.rec ?? {};
    lines.push([r.row, r.errors.join("; "), ...headers.map((h) => rec[h])].map(q).join(","));
  }
  return lines.join("\n");
}
