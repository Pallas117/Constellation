import { useEffect, useId, useState, type ChangeEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { StatusBadge, type BadgeTone } from "@/components/brand/StatusBadge";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { evidenceApi, packFileText, type Analysis, type EvidenceOptions, type EvidencePack, type PackCheck, type TrustRecord } from "@/lib/api/evidence";

const OWN_MAPPING = "__own__";
const utc = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").replace(/(:\d\d)(\.\d+)?Z$/, "$1 UT") : "—");
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Verdict words as the records carry them; the tone never stands alone, the word is always shown. */
const VERDICT_TONE: Record<TrustRecord["verdict"]["value"], BadgeTone> = { consistent: "neutral", "degraded-context": "caution", unknown: "caution" };

function save(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Step({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="hud-panel min-w-0 p-4 sm:p-6">
      <p className="brand-label">{label}</p>
      <h2 id={id} className="mt-2 text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-sm">{children}</div>
    </section>
  );
}

function Fact({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
      <dt className="stat-label">{label}</dt>
      <dd className="mt-1.5 break-all font-mono text-xs tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

const fieldClass = "h-9 w-full rounded border border-charcoal bg-background px-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground";

/**
 * The pilot flow a buyer sees (GAU-59): a customer inference log becomes trust records, then an
 * evidence pack (JSON + PDF), then the same check `npm run trust:verify` runs. The pack is never
 * signed here: signing needs the key holder at the host.
 */
export default function Evidence() {
  useDocumentTitle("Evidence");
  const [options, setOptions] = useState<EvidenceOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [log, setLog] = useState<{ name: string; text: string; synthetic: boolean } | null>(null);
  const [mappingId, setMappingId] = useState("");
  const [ownMapping, setOwnMapping] = useState<{ name: string; value: unknown } | null>(null);
  const [eventId, setEventId] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);

  const [other, setOther] = useState<{ name: string; pack: unknown } | null>(null);
  const [allowUnsigned, setAllowUnsigned] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<PackCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // One read when the page opens; nothing on this page polls.
  useEffect(() => {
    evidenceApi
      .options()
      .then((o) => {
        setOptions(o);
        setMappingId(o.mappings[0]?.id ?? OWN_MAPPING);
        setEventId(o.events[0]?.id ?? "");
      })
      .catch((e) => setLoadError(message(e, "Could not load the evidence options")));
  }, []);

  const pickLog = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !options) return;
    setInputError(null);
    if (file.size > options.maxLogBytes) {
      setLog(null);
      setInputError(`${file.name} is over ${options.maxLogBytes / 1_000_000} MB. Run a log this size from the command line (docs/PILOT_RUNBOOK.md).`);
      return;
    }
    setLog({ name: file.name, text: await file.text(), synthetic: false });
  };

  const useSample = () => {
    if (!options) return;
    setInputError(null);
    setLog({ name: options.sample.name, text: options.sample.text, synthetic: true });
    setMappingId(options.sample.mappingId);
    setEventId(options.sample.eventId);
  };

  const pickMapping = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setOwnMapping({ name: file.name, value: JSON.parse(await file.text()) });
      setInputError(null);
    } catch {
      setOwnMapping(null);
      setInputError(`${file.name} is not JSON.`);
    }
  };

  const analyse = async () => {
    if (!log || !eventId) return;
    setRunning(true);
    setRunError(null);
    setPackError(null);
    setCheck(null);
    setCheckError(null);
    try {
      setAnalysis(await evidenceApi.analyse({ log: log.text, eventId, ...(mappingId === OWN_MAPPING ? { mapping: ownMapping?.value } : { mappingId }) }));
    } catch (e) {
      setAnalysis(null);
      setRunError(message(e, "The analysis could not be run"));
    } finally {
      setRunning(false);
    }
  };

  const pack: EvidencePack | null = analysis?.pack ?? null;

  const downloadPdf = async () => {
    if (!pack) return;
    setPdfBusy(true);
    setPackError(null);
    try {
      save(`${pack.packId}.pdf`, await evidenceApi.pdf(pack));
    } catch (e) {
      setPackError(message(e, "The PDF could not be made"));
    } finally {
      setPdfBusy(false);
    }
  };

  const pickPack = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCheck(null);
    try {
      setOther({ name: file.name, pack: JSON.parse(await file.text()) });
      setCheckError(null);
    } catch {
      setOther(null);
      setCheckError(`${file.name} is not JSON.`);
    }
  };

  const subject = other ? other : pack ? { name: `${pack.packId}.json`, pack } : null;
  const verify = async () => {
    if (!subject) return;
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await evidenceApi.verify(subject.pack, subject.name, allowUnsigned));
    } catch (e) {
      setCheck(null);
      setCheckError(message(e, "The check could not be run"));
    } finally {
      setChecking(false);
    }
  };

  const canRun = Boolean(log && eventId && (mappingId !== OWN_MAPPING || ownMapping)) && !running;
  const commit = pack?.inputs.software.commit ?? "";
  const commitDoubt = commit === "unknown" || commit.endsWith("+modified");

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <header className="px-4 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="brand-label">00_EVIDENCE</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Evidence for a customer log.</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              Load an inference log, read what Gauss knew about the space environment at each inference, and hand over a pack the customer can check
              offline. The environment is replayed from a stored storm, so a past window is judged by what was known at the time.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/operator">Operator console</Link>
          </Button>
        </div>
      </header>

      <div className="grid gap-6 px-4 pb-10 sm:px-8">
        {loadError && (
          <p role="alert" className="text-sm text-foreground">
            <StatusBadge tone="risk" className="mr-2">Unavailable</StatusBadge>
            {loadError}
          </p>
        )}
        {!options && !loadError && (
          <p role="status" className="font-mono text-sm text-muted-foreground">
            Loading the evidence options…
          </p>
        )}

        {options && (
          <Step label="01_LOG" title="Load the inference log.">
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="min-w-0 space-y-2">
                <label htmlFor="evidence-log" className="stat-label block">
                  Log file (CSV, JSON or JSONL)
                </label>
                <input id="evidence-log" type="file" accept=".csv,.json,.jsonl,text/csv,application/json" onChange={(e) => void pickLog(e)} className="block w-full text-xs text-muted-foreground file:mr-3 file:h-9 file:rounded file:border file:border-solid file:border-charcoal file:bg-background file:px-3 file:font-mono file:text-xs file:text-foreground" />
                <Button type="button" variant="outline" size="sm" onClick={useSample}>
                  Use the synthetic sample
                </Button>
              </div>
              <div className="min-w-0 space-y-2">
                <label htmlFor="evidence-mapping" className="stat-label block">
                  Column mapping
                </label>
                <select id="evidence-mapping" value={mappingId} onChange={(e) => setMappingId(e.target.value)} className={fieldClass}>
                  {options.mappings.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} {m.version} ({m.format})
                    </option>
                  ))}
                  <option value={OWN_MAPPING}>The customer's mapping file…</option>
                </select>
                {mappingId === OWN_MAPPING && (
                  <input aria-label="Mapping file (JSON)" type="file" accept=".json,application/json" onChange={(e) => void pickMapping(e)} className="block w-full text-xs text-muted-foreground file:mr-3 file:h-9 file:rounded file:border file:border-solid file:border-charcoal file:bg-background file:px-3 file:font-mono file:text-xs file:text-foreground" />
                )}
              </div>
              <div className="min-w-0 space-y-2">
                <label htmlFor="evidence-event" className="stat-label block">
                  Environment replayed from
                </label>
                <select id="evidence-event" value={eventId} onChange={(e) => setEventId(e.target.value)} className={fieldClass}>
                  {options.events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title ? `${ev.id}: ${ev.title}` : ev.id}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-charcoal pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-w-0 font-mono text-xs text-muted-foreground" data-testid="evidence-log-state">
                {log ? (
                  <>
                    <span className="break-all text-foreground">{log.name}</span> · {new Blob([log.text]).size.toLocaleString()} bytes
                    {log.synthetic ? " · synthetic, not customer data" : " · stays on this host; removed after the run"}
                  </>
                ) : (
                  "No log loaded."
                )}
              </p>
              <Button type="button" onClick={() => void analyse()} disabled={!canRun} className="shrink-0">
                {running ? "Replaying…" : "Build trust records"}
              </Button>
            </div>
            {inputError && (
              <p role="alert" className="text-sm text-caution">
                {inputError}
              </p>
            )}
            {runError && (
              <p role="alert" className="text-sm text-foreground">
                <StatusBadge tone="risk" className="mr-2">Not built</StatusBadge>
                {runError}
              </p>
            )}
          </Step>
        )}

        {analysis && pack && (
          <>
            <Step label="02_TRUST_RECORDS" title="One record for every accepted row.">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Fact label="Rows in the log">{analysis.summary.file.rows}</Fact>
                <Fact label="Records">{analysis.summary.accepted}</Fact>
                <Fact label="Rows not used">{pack.inputs.log?.rejected.length ?? analysis.summary.rejected.length}</Fact>
                <Fact label="Environment">{pack.inputs.environment.source}</Fact>
              </dl>

              {/* Phone: one card per record, so the verdict is never off-screen. */}
              <ul aria-label="Trust records" className="space-y-3 sm:hidden">
                {analysis.records.map((r) => (
                  <li key={r.recordId} className="rounded border border-charcoal p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 font-mono text-xs tabular-nums">
                        <span className="text-muted-foreground">row {r.inference.ingest?.row ?? "—"} · </span>
                        {utc(r.inference.time)}
                      </p>
                      <StatusBadge tone={VERDICT_TONE[r.verdict.value] ?? "caution"} className="shrink-0">
                        {r.verdict.value}
                      </StatusBadge>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs">
                      {r.inference.spacecraftId} · {r.inference.modelId}
                    </p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      radiation {r.environment.radiation.value?.label ?? "—"} · geomagnetic {r.environment.geomagnetic.value?.label ?? "—"} · SAA{" "}
                      {r.orbit.saa.value === null ? "—" : r.orbit.saa.value ? "inside" : "outside"}
                    </p>
                    {r.verdict.reasons[0] && <p className="mt-2 text-xs text-muted-foreground">{r.verdict.reasons[0]}</p>}
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <caption className="sr-only">Trust records</caption>
                  <thead>
                    <tr className="border-b border-charcoal">
                      {["Row", "Inference time", "Spacecraft", "Model", "Radiation", "Geomagnetic", "SAA", "Verdict"].map((h) => (
                        <th key={h} scope="col" className="stat-label py-2 pr-4 align-bottom">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {analysis.records.map((r) => (
                      <tr key={r.recordId} className="border-b border-charcoal/60 align-top">
                        <td className="py-2 pr-4 text-muted-foreground">{r.inference.ingest?.row ?? "—"}</td>
                        <td className="whitespace-nowrap py-2 pr-4">{utc(r.inference.time)}</td>
                        <td className="py-2 pr-4">{r.inference.spacecraftId}</td>
                        <td className="py-2 pr-4">{r.inference.modelId}</td>
                        <td className="py-2 pr-4">{r.environment.radiation.value?.label ?? "—"}</td>
                        <td className="py-2 pr-4">{r.environment.geomagnetic.value?.label ?? "—"}</td>
                        <td className="py-2 pr-4">{r.orbit.saa.value === null ? "—" : r.orbit.saa.value ? "inside" : "outside"}</td>
                        <td className="py-2">
                          <StatusBadge tone={VERDICT_TONE[r.verdict.value] ?? "caution"}>{r.verdict.value}</StatusBadge>
                          {r.verdict.reasons[0] && <p className="mt-1.5 max-w-xs font-sans text-muted-foreground">{r.verdict.reasons[0]}</p>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {pack.inputs.log && pack.inputs.log.rejected.length > 0 && (
                <div>
                  <p className="stat-label">Rows not used, with the reason</p>
                  <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                    {pack.inputs.log.rejected.map((r) => (
                      <li key={r.row}>
                        <span className="text-foreground">row {r.row}</span> · {r.errors.join("; ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Step>

            <div className="grid gap-6 xl:grid-cols-2">
              <Step label="03_EVIDENCE_PACK" title="The pack the customer keeps.">
                <dl className="grid gap-4 sm:grid-cols-2">
                  <Fact label="Pack">{pack.packId}</Fact>
                  <Fact label="Records">{pack.summary.records}</Fact>
                  <Fact label="Window" wide>
                    {utc(pack.window.from)} to {utc(pack.window.to)}
                  </Fact>
                  <Fact label="Pack hash (SHA-256)" wide>
                    {pack.packHash}
                  </Fact>
                  <Fact label="Log file (SHA-256)" wide>
                    {pack.inputs.log?.fileSha256 ?? "—"}
                  </Fact>
                  <Fact label="Software" wide>
                    {commit || "—"}
                    {commitDoubt && <span className="ml-2 font-sans text-caution">not a clean release build</span>}
                  </Fact>
                </dl>

                <div className="space-y-2 border-t border-charcoal pt-4">
                  <StatusBadge tone={pack.signature ? "neutral" : "caution"}>{pack.signature ? `Signed by ${pack.signature.keyId}` : "Not signed"}</StatusBadge>
                  {!pack.signature && (
                    <>
                      <p className="text-muted-foreground">
                        This page cannot sign. The signing key stays with its holder, who signs the downloaded pack on the host and unlocks the key
                        there:
                      </p>
                      <pre className="whitespace-pre-wrap break-words rounded border border-charcoal bg-background p-2 font-mono text-xs">{analysis.signOnHost}</pre>
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button type="button" variant="outline" onClick={() => save(`${pack.packId}.json`, new Blob([packFileText(pack)], { type: "application/json" }))}>
                    Download pack.json
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void downloadPdf()} disabled={pdfBusy}>
                    {pdfBusy ? "Drawing the PDF…" : "Download pack.pdf"}
                  </Button>
                </div>
                {packError && (
                  <p role="alert" className="text-sm text-caution">
                    {packError}
                  </p>
                )}

                <div>
                  <p className="stat-label">Limits stated in the pack</p>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {pack.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
              </Step>

              <VerifyStep
                options={options}
                subjectName={subject?.name ?? null}
                usingOther={Boolean(other)}
                onPick={(e) => void pickPack(e)}
                onUseBuilt={() => {
                  setOther(null);
                  setCheck(null);
                }}
                allowUnsigned={allowUnsigned}
                onAllowUnsigned={(v) => {
                  setAllowUnsigned(v);
                  setCheck(null);
                }}
                checking={checking}
                onVerify={() => void verify()}
                check={check}
                error={checkError}
              />
            </div>
          </>
        )}

        {options && !analysis && (
          <VerifyStep
            options={options}
            subjectName={subject?.name ?? null}
            usingOther={Boolean(other)}
            onPick={(e) => void pickPack(e)}
            onUseBuilt={() => setOther(null)}
            allowUnsigned={allowUnsigned}
            onAllowUnsigned={(v) => {
              setAllowUnsigned(v);
              setCheck(null);
            }}
            checking={checking}
            onVerify={() => void verify()}
            check={check}
            error={checkError}
          />
        )}
      </div>
    </main>
  );
}

function VerifyStep(props: {
  options: EvidenceOptions | null;
  subjectName: string | null;
  usingOther: boolean;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  onUseBuilt: () => void;
  allowUnsigned: boolean;
  onAllowUnsigned: (v: boolean) => void;
  checking: boolean;
  onVerify: () => void;
  check: PackCheck | null;
  error: string | null;
}) {
  const { options, check } = props;
  return (
    <Step label="04_VERIFY" title="Check a pack against the published keys.">
      <p className="text-muted-foreground">
        The same check as <span className="font-mono text-foreground">npm run trust:verify</span>: every record hash, the chain, the pack hash, the
        wording rules and the signature.
      </p>
      <div className="space-y-2">
        <label htmlFor="evidence-pack-file" className="stat-label block">
          A pack file (pack.json), e.g. one signed on the host
        </label>
        <input id="evidence-pack-file" type="file" accept=".json,application/json" onChange={props.onPick} className="block w-full text-xs text-muted-foreground file:mr-3 file:h-9 file:rounded file:border file:border-solid file:border-charcoal file:bg-background file:px-3 file:font-mono file:text-xs file:text-foreground" />
        {props.usingOther && (
          <Button type="button" variant="ghost" size="sm" onClick={props.onUseBuilt}>
            Check the pack built above instead
          </Button>
        )}
      </div>
      <label className="flex items-start gap-2 text-muted-foreground">
        <input type="checkbox" checked={props.allowUnsigned} onChange={(e) => props.onAllowUnsigned(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[hsl(var(--foreground))]" />
        <span>
          Integrity only: accept a pack with no signature (<span className="font-mono">--allow-unsigned</span>). It then shows nothing about who made it.
        </span>
      </label>
      <div className="flex flex-col gap-3 border-t border-charcoal pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 break-all font-mono text-xs text-muted-foreground">{props.subjectName ?? "No pack to check yet."}</p>
        <Button type="button" variant="outline" onClick={props.onVerify} disabled={!props.subjectName || props.checking} className="shrink-0">
          {props.checking ? "Checking…" : "Verify pack"}
        </Button>
      </div>
      {props.error && (
        <p role="alert" className="text-sm text-caution">
          {props.error}
        </p>
      )}
      {check && (
        <div role="status" aria-label="Verification result" className="space-y-2">
          <StatusBadge tone={check.ok ? "neutral" : "risk"}>{check.ok ? "OK" : "FAILED"}</StatusBadge>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-charcoal bg-background p-3 font-mono text-xs">{check.lines.join("\n")}</pre>
        </div>
      )}
      {options && (
        <div>
          <p className="stat-label">Published keys ({options.keyring})</p>
          {options.keys.length === 0 ? (
            <p className="mt-2 text-xs text-caution">No signing key is published yet, so no pack can pass the signature check.</p>
          ) : (
            <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
              {options.keys.map((k) => (
                <li key={k.keyId}>
                  <span className="text-foreground">{k.keyId}</span> · {k.purposes.join(", ")} · {k.status}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Step>
  );
}
