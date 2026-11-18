import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge, type BadgeTone } from "@/components/brand/StatusBadge";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import {
  FIELDS,
  MAX_BROWSER_BYTES,
  SAMPLE_LOG_CSV,
  buildMapping,
  detectFormat,
  ingestCommand,
  mappingId,
  previewLog,
  readLog,
  rejectedCsv,
  suggestMapping,
  wiringProblems,
  type Confidence,
  type FieldKey,
  type ReadLog,
  type Suggestion,
  type TimeFormat,
} from "@/lib/log-wiring";

type Loaded = { name: string; log: ReadLog; suggestion: Suggestion };
type Columns = Partial<Record<FieldKey, string | string[]>>;

const CONFIDENCE: Record<Confidence | "none", { tone: BadgeTone; text: string }> = {
  high: { tone: "neutral", text: "found" },
  medium: { tone: "caution", text: "check" },
  low: { tone: "caution", text: "check" },
  none: { tone: "caution", text: "choose" },
};

function save(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function copy(text: string, say: (m: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    say("Copied.");
  } catch {
    say("Copy was blocked by the browser. Select the text and copy it by hand.");
  }
}

/** Read a customer's inference log in this browser and wire it to Gauss: suggested mapping, preview, command. */
const LogWiring = () => {
  useDocumentTitle("Wire your logs");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<Columns>({});
  const [constants, setConstants] = useState<{ spacecraftId?: string; modelId?: string; processorProfileId?: string }>({});
  const [timeFormat, setTimeFormat] = useState<TimeFormat>("iso");
  const [assumeUtc, setAssumeUtc] = useState(false);
  const [event, setEvent] = useState("jan-2026");
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback((name: string, text: string) => {
    const format = detectFormat(name, text);
    const log = readLog(text, format);
    if ("error" in log) {
      setLoaded(null);
      setError(log.error);
      return;
    }
    const suggestion = suggestMapping(log.headers, log.records);
    setError(null);
    setLoaded({ name, log, suggestion });
    setColumns(suggestion.columns);
    setConstants({});
    setTimeFormat(suggestion.timeFormat);
    setAssumeUtc(false);
    setNote("");
  }, []);

  const openFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (file.size > MAX_BROWSER_BYTES) {
        setLoaded(null);
        setError(`This file is ${(file.size / 1048576).toFixed(0)} MB. The browser handles up to ${MAX_BROWSER_BYTES / 1048576} MB; for larger logs, run the command-line tool on the file directly.`);
        return;
      }
      load(file.name, await file.text());
    },
    [load],
  );

  const mapping = useMemo(
    () => (loaded ? buildMapping({ format: loaded.log.format, timeFormat, assumeUtc, columns, constants, id: mappingId(loaded.name) }) : null),
    [loaded, timeFormat, assumeUtc, columns, constants],
  );
  const problems = useMemo(() => (loaded && mapping ? wiringProblems(mapping, loaded.log.headers) : []), [loaded, mapping]);
  const preview = useMemo(() => (loaded && mapping && problems.length === 0 ? previewLog(loaded.log.records, mapping) : null), [loaded, mapping, problems]);

  const setColumn = (key: FieldKey, value: string) => setColumns((c) => ({ ...c, [key]: value || undefined }));
  const toggleOutput = (h: string) =>
    setColumns((c) => {
      const cur = [c.output ?? []].flat();
      const next = cur.includes(h) ? cur.filter((x) => x !== h) : [...cur, h];
      return { ...c, output: next.length ? next : undefined };
    });

  const mappingName = loaded && mapping ? `${mapping.id}.mapping.json` : "mapping.json";
  const mappingJson = mapping ? JSON.stringify(mapping, null, 2) : "";
  const ready = !!preview && preview.accepted > 0;

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <section className="px-4 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="brand-label">00_WIRE_YOUR_LOGS</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Wire your logs</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Drop an inference log. Gauss suggests how its columns map, shows which rows it would accept and why it would reject the rest, and
              gives you the mapping file and the command to run. <strong className="font-medium text-foreground">Your file is read in this browser and is not uploaded.</strong>
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/account/api">API keys</Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-6 px-4 pb-10 sm:px-8">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3 text-base">
              <span className="brand-label">01</span> Choose a log
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void openFile(e.dataTransfer.files[0]);
              }}
              className={`flex flex-col items-start gap-3 rounded-md border border-dashed p-6 sm:flex-row sm:items-center ${dragging ? "border-signal" : "border-charcoal"}`}
            >
              <div className="flex-1">
                <p className="text-sm font-medium">{loaded ? loaded.name : "Drop a .csv, .json or .jsonl file here"}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {loaded
                    ? `${loaded.log.format.toUpperCase()} · ${loaded.log.records.length.toLocaleString()} rows · ${loaded.log.headers.length} columns`
                    : "One row per inference. Times in ISO 8601 with a zone (…Z), or epoch seconds or milliseconds."}
                </p>
              </div>
              <input ref={input} type="file" accept=".csv,.json,.jsonl,.ndjson,text/csv,application/json" className="sr-only" aria-label="Choose a log file" onChange={(e) => void openFile(e.target.files?.[0])} />
              <Button onClick={() => input.current?.click()}>{loaded ? "Choose another" : "Choose file"}</Button>
              <Button variant="outline" onClick={() => load("sample-log.csv", SAMPLE_LOG_CSV)}>
                Try a sample
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-caution">
                {error}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Nothing here sends your data anywhere. Gauss only sees a log when you run the command below on your own machine.
            </p>
          </CardContent>
        </Card>

        {loaded && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-3 text-base">
                <span className="brand-label">02</span> Check the mapping
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {loaded.suggestion.notes.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-caution">
                  {loaded.suggestion.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
                {FIELDS.map((f) => {
                  const id = `map-${f.key}`;
                  const chosen = columns[f.key];
                  const conf = chosen ? CONFIDENCE[loaded.suggestion.confidence[f.key] ?? "high"] : CONFIDENCE.none;
                  const canBeConstant = f.key === "spacecraftId" || f.key === "modelId" || f.key === "processorProfileId";
                  return (
                    <div key={f.key} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <label htmlFor={id} className="text-sm font-medium">
                          {f.label}
                          {f.required && <span className="text-muted-foreground"> · required</span>}
                        </label>
                        {(chosen || f.required) && <StatusBadge tone={conf.tone}>{conf.text}</StatusBadge>}
                      </div>
                      {f.key === "output" ? (
                        <div id={id} role="group" aria-label="Output columns" className="flex flex-wrap gap-2">
                          {loaded.log.headers.map((h) => {
                            const on = [columns.output ?? []].flat().includes(h);
                            return (
                              <button
                                key={h}
                                type="button"
                                aria-pressed={on}
                                onClick={() => toggleOutput(h)}
                                className={`rounded-full border px-3 py-1 font-mono text-xs ${on ? "border-foreground text-foreground" : "border-charcoal text-muted-foreground"}`}
                              >
                                {h}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <select
                          id={id}
                          value={typeof chosen === "string" ? chosen : ""}
                          onChange={(e) => setColumn(f.key, e.target.value)}
                          className="h-9 w-full rounded-md border border-charcoal bg-background px-2 font-mono text-sm"
                        >
                          <option value="">{canBeConstant ? "No column (type a value below)" : "Not in this file"}</option>
                          {loaded.log.headers.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      )}
                      {canBeConstant && !columns[f.key as FieldKey] && (
                        <Input
                          aria-label={`${f.label}, same for every row`}
                          placeholder={f.key === "spacecraftId" ? "e.g. SAT-9 (same for the whole file)" : f.key === "modelId" ? "e.g. cloudmask-v3.2" : "e.g. jetson-orin-nx"}
                          value={constants[f.key as "spacecraftId" | "modelId" | "processorProfileId"] ?? ""}
                          maxLength={128}
                          onChange={(e) => setConstants((c) => ({ ...c, [f.key]: e.target.value }))}
                        />
                      )}
                      {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
                    </div>
                  );
                })}
              </div>

              <div className="grid gap-4 border-t border-border/60 pt-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="time-format" className="text-sm font-medium">
                    How times are written
                  </label>
                  <select id="time-format" value={timeFormat} onChange={(e) => setTimeFormat(e.target.value as TimeFormat)} className="h-9 w-full rounded-md border border-charcoal bg-background px-2 text-sm">
                    <option value="iso">ISO 8601 (2026-01-19T02:10:00Z)</option>
                    <option value="unix-s">Epoch seconds</option>
                    <option value="unix-ms">Epoch milliseconds</option>
                  </select>
                </div>
                {timeFormat === "iso" && (
                  <div className="space-y-1.5">
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" checked={assumeUtc} onChange={(e) => setAssumeUtc(e.target.checked)} className="mt-1" />
                      <span>
                        <span className="font-medium">Times with no zone are UTC</span>
                        <span className="block text-xs text-muted-foreground">
                          Tick only if you know it. Gauss never guesses a zone: an unzoned time is rejected unless you confirm this.
                          {loaded.suggestion.needsUtcConfirmation && <span className="text-caution"> None of your times has a zone.</span>}
                        </span>
                      </span>
                    </label>
                  </div>
                )}
              </div>

              {problems.length > 0 && (
                <ul role="status" className="list-disc space-y-1 pl-5 text-sm text-caution">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {loaded && preview && mapping && (
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3 text-base">
                <span className="brand-label">03</span> Preview: what Gauss would take
                <StatusBadge tone={preview.rejected.length === 0 ? "neutral" : "caution"}>
                  {preview.accepted.toLocaleString()} of {preview.rows.toLocaleString()} rows accepted
                </StatusBadge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                A check in your browser, with the same row rules as the real run. It does not hash or sign anything and writes nothing.
              </p>
              {preview.samples.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="pb-2 text-left text-xs uppercase tracking-wider text-muted-foreground">First accepted rows</caption>
                    <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-4">Row</th>
                        <th className="py-2 pr-4">Time as written</th>
                        <th className="py-2 pr-4">Read as UTC</th>
                        <th className="py-2 pr-4">Spacecraft</th>
                        <th className="py-2 pr-4">Model</th>
                        <th className="py-2 pr-4">Position</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.samples.map((s) => (
                        <tr key={s.row} className="border-t border-border/60 font-mono text-xs">
                          <td className="py-2 pr-4">{s.row}</td>
                          <td className="py-2 pr-4">{String(loaded.log.records[s.row - 1]?.rec?.[mapping.columns.time] ?? "")}</td>
                          <td className="py-2 pr-4">{s.time}</td>
                          <td className="py-2 pr-4">{s.spacecraftId}</td>
                          <td className="py-2 pr-4">{s.modelId}</td>
                          <td className="py-2 pr-4">{s.hasPosition ? "yes" : "no"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {preview.rejected.length > 0 && (
                <div className="space-y-3 border-t border-border/60 pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{preview.rejected.length.toLocaleString()} rows would be rejected, none silently</p>
                    <Button size="sm" variant="outline" onClick={() => save(`${mapping.id}.rejected.csv`, rejectedCsv(preview, loaded.log.records, loaded.log.headers), "text/csv")}>
                      Download rejected rows (CSV)
                    </Button>
                  </div>
                  <ul className="space-y-1 text-sm">
                    {preview.reasons.slice(0, 6).map((r) => (
                      <li key={r.reason} className="flex gap-3">
                        <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">×{r.count}</span>
                        <span>{r.reason}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="pb-2 text-left text-xs uppercase tracking-wider text-muted-foreground">First rejected rows</caption>
                      <tbody>
                        {preview.rejected.slice(0, 10).map((r) => (
                          <tr key={r.row} className="border-t border-border/60 align-top">
                            <td className="w-16 py-2 pr-4 font-mono text-xs">row {r.row}</td>
                            <td className="py-2 text-xs text-muted-foreground">{r.errors.join("; ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {loaded && mapping && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-3 text-base">
                <span className="brand-label">04</span> Run it
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!ready && <p className="text-sm text-caution">Fix the mapping above first; the file and command appear once at least one row would be accepted.</p>}
              {ready && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => save(mappingName, `${mappingJson}\n`, "application/json")}>Download {mappingName}</Button>
                    <Button variant="outline" onClick={() => void copy(mappingJson, setNote)}>
                      Copy mapping
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="event" className="text-sm font-medium">
                      Storm to replay
                    </label>
                    <Input id="event" value={event} onChange={(e) => setEvent(e.target.value.replace(/[^a-z0-9-]/gi, ""))} className="max-w-xs font-mono text-xs" maxLength={40} />
                    <p className="text-xs text-muted-foreground">Pick the event whose dates your log covers. The default is the 19 January 2026 radiation storm.</p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm">Put the mapping next to your log, then run this in the Gauss repository:</p>
                    <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{ingestCommand(loaded.name, mappingName, event || "jan-2026")}</pre>
                    <Button size="sm" variant="outline" onClick={() => void copy(ingestCommand(loaded.name, mappingName, event || "jan-2026"), setNote)}>
                      Copy command
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The run hashes your file, records each row's position in it, and writes a per-row report. Both the preview and the run keep every rejected row with its reason.
                  </p>
                </>
              )}
              <p role="status" aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
                {note}
              </p>
            </CardContent>
          </Card>
        )}
      </section>
    </main>
  );
};

export default LogWiring;
