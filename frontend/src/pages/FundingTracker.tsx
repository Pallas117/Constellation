import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { StatusBadge } from "@/components/brand/StatusBadge";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { readFundingTracker, type FundingAnswer, type FundingDue, type FundingRow, type FundingTracker as Tracker } from "@/lib/api/funding";
import { DASH, dayWords, dueWords, exportAgeDays, exportedWords, groupByStage, safeLink, STALE_AFTER_DAYS, TYPE_WORD, type FundingType } from "@/lib/funding-view";

const TYPES: FundingType[] = ["investor", "grant", "programme", "bid", "other"];
const TYPE_PLURAL: Record<FundingType, string> = { investor: "Investors", grant: "Grants", programme: "Programmes", bid: "Bids", other: "Other" };
const FIELD_WORD: Record<string, string> = {
  name: "Name",
  organisation: "Organisation",
  stage: "Stage",
  amount: "Amount",
  deadline: "Deadline",
  nextAction: "Next action",
  nextActionDate: "Next action date",
  owner: "Owner",
  link: "Link",
  lastContact: "Last contact",
  file: "Whole file",
};
/** The header wording the export may use (backend/funding/tracker.ts matches case, spacing and a few synonyms). */
const COLUMNS = "Name, Type, Organisation, Stage, Amount, Deadline, Next action, Next action date, Owner, Link, Last contact";

const text = (v: string | null | undefined) => (v && v.trim() !== "" ? v : DASH);
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? String(n) : DASH);

function Section({ label, title, children }: { label: string; title: string; children: ReactNode }) {
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="stat-label">{label}</dt>
      <dd className="mt-1.5 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

function TypeWord({ type }: { type: FundingType }) {
  return <span className="shrink-0 rounded border border-charcoal px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{TYPE_WORD[type] ?? TYPE_WORD.other}</span>;
}

/** One dated thing to do: what it is, for which row, and how far away in words (never by colour alone). */
function DueList({ items, rows, late, empty, name }: { items: FundingDue[]; rows: Map<number, FundingRow>; late: boolean; empty: string; name: string }) {
  if (items.length === 0) return <p className="text-muted-foreground">{empty}</p>;
  return (
    <ul aria-label={name} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => {
        const row = rows.get(item.row);
        return (
          <li key={`${item.row}-${item.kind}`} className="min-w-0 rounded-lg border border-charcoal bg-background p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusBadge tone={late ? "risk" : "caution"}>{late ? "Overdue" : "Due"}</StatusBadge>
              <span className="font-mono text-xs tabular-nums text-foreground">
                {dayWords(item.date)} <span className="text-muted-foreground">· {dueWords(item.days)}</span>
              </span>
            </div>
            <p className="mt-2 break-words font-semibold">{text(row?.name)}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {item.kind === "deadline" ? "Deadline" : `Next action: ${text(row?.nextAction)}`}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {row && <TypeWord type={row.type} />}
              <span className="break-words">{text(row?.organisation)}</span>
              <span className="break-words">· Stage: {text(row?.stage)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RowCard({ row }: { row: FundingRow }) {
  const link = safeLink(row.link);
  return (
    <li className="min-w-0 rounded-lg border border-charcoal bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-semibold">{text(row.name)}</p>
        <TypeWord type={row.type} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact label="Organisation">{text(row.organisation)}</Fact>
        <Fact label="Amount (as written)">{text(row.amount)}</Fact>
        <Fact label="Deadline">
          <span className="font-mono text-xs tabular-nums">{dayWords(row.deadline)}</span>
        </Fact>
        <Fact label="Last contact">
          <span className="font-mono text-xs tabular-nums">{dayWords(row.lastContact)}</span>
        </Fact>
        <div className="col-span-2">
          <Fact label="Next action">
            {text(row.nextAction)}
            <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">by {dayWords(row.nextActionDate)}</span>
          </Fact>
        </div>
        <Fact label="Owner">{text(row.owner)}</Fact>
        <Fact label="Link">
          {link ? (
            <a href={link.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="break-all underline underline-offset-2 hover:text-foreground">
              {link.host}
            </a>
          ) : (
            DASH
          )}
        </Fact>
      </dl>
      <p className="mt-3 font-mono text-[11px] text-muted-foreground">Sheet row {count(row.row)}</p>
    </li>
  );
}

function SwitchOn() {
  return (
    <Section label="01_SWITCH_ON" title="The tracker view is switched off on this server.">
      <p className="max-w-2xl text-muted-foreground">
        It shows a copy of the funding tracker that stays on this machine. Nothing is uploaded and the Sheet is not connected: the backend reads one CSV
        file you export yourself.
      </p>
      <ol className="max-w-2xl list-decimal space-y-2 pl-5">
        <li>In the Sheet, open the tracker tab and choose File, Download, Comma-separated values (.csv).</li>
        <li>Keep the file in a folder outside the repository, readable only by you (chmod 600).</li>
        <li>
          Set <code className="font-mono text-xs">FUNDING_TRACKER_CSV</code> to the file's absolute path in the backend's environment, then restart the backend.
        </li>
        <li>Press Reload here. Export again whenever the Sheet changes: this page never updates itself.</li>
      </ol>
      <p className="max-w-2xl text-xs text-muted-foreground">
        Columns it reads (other columns are ignored): <span className="font-mono">{COLUMNS}</span>. Dates as 2026-11-01, 1 Nov 2026 or Rolling.
      </p>
    </Section>
  );
}

function TrackerView({ data }: { data: Tracker }) {
  const rows = new Map(data.rows.map((r) => [r.row, r]));
  const groups = groupByStage(data.rows);
  const strip: Array<[string, number | undefined]> = [
    ["In the tracker", data.counts.total],
    ...TYPES.map((t): [string, number | undefined] => [TYPE_PLURAL[t], data.counts.byType[t]]),
    ["Due in 30 days", data.upcoming.length],
    ["Overdue", data.overdue.length],
  ];
  return (
    <>
      <section aria-label="Counts" className="hud-panel p-4 sm:p-6">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4 xl:grid-cols-8">
          {strip.map(([label, n]) => (
            <div key={label} className="min-w-0">
              <dt className="stat-label">{label}</dt>
              <dd className="mt-2 font-mono text-2xl tabular-nums text-foreground">{count(n)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Section label="01_DUE" title="Due in the next 30 days.">
        <DueList name="Due in the next 30 days" items={data.upcoming} rows={rows} late={false} empty="Nothing in the copy is due in the next 30 days." />
      </Section>

      <Section label="02_OVERDUE" title="Overdue and not closed.">
        <DueList name="Overdue" items={data.overdue} rows={rows} late empty="Nothing in the copy is overdue." />
      </Section>

      <Section label="03_PIPELINE" title="The pipeline, by stage.">
        {groups.length === 0 && <p className="text-muted-foreground">The export has no rows.</p>}
        {groups.map((group) => (
          <div key={group.stage ?? ""} className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 font-mono text-xs uppercase tracking-[0.08em] text-foreground">
              {group.stage ?? "No stage given"}
              <span className="text-muted-foreground">
                · {group.rows.length} {group.rows.length === 1 ? "row" : "rows"}
                {group.closed ? " · closed" : ""}
              </span>
            </h3>
            <ul aria-label={`Stage: ${group.stage ?? "none given"}`} className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {group.rows.map((row) => (
                <RowCard key={row.row} row={row} />
              ))}
            </ul>
          </div>
        ))}
      </Section>

      <Section label="04_COPY_CHECK" title="What the copy could not read.">
        {data.problems.length === 0 ? (
          <p className="text-muted-foreground">Every row and date in the export was read.</p>
        ) : (
          <ul aria-label="Problems in the export" className="space-y-2">
            {data.problems.map((p, i) => (
              <li key={i} className="break-words font-mono text-xs text-foreground">
                {p.row > 0 ? `Sheet row ${count(p.row)}` : "Export"} · {FIELD_WORD[p.field] ?? "Field"} · <span className="text-muted-foreground">{text(p.reason)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {count(data.ignoredColumns)} {data.ignoredColumns === 1 ? "column" : "columns"} in the export {data.ignoredColumns === 1 ? "is" : "are"} not shown here. Fix problems in the
          Sheet, export again and press Reload.
        </p>
        {data.readableByOthers && (
          <p className="text-sm text-foreground">
            <StatusBadge tone="caution" className="mr-2">File permissions</StatusBadge>
            Other accounts on this machine can read the export file: chmod 600 it.
          </p>
        )}
      </Section>
    </>
  );
}

/**
 * Admin-only, read-only copy of the funding tracker (investors, grant and programme applications,
 * bids). One read when the page opens and one per press of Reload; no polling, no edit controls.
 * The route guard (ProtectedRoute minRole="admin") keeps every other role from mounting this page,
 * so it never calls a route the role can't use.
 */
export default function FundingTracker() {
  useDocumentTitle("Funding tracker");
  const [answer, setAnswer] = useState<FundingAnswer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const opened = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setAnswer(await readFundingTracker());
    } catch (error) {
      setAnswer(null); // an old copy is not left on screen as if it were the answer
      setFailure(error instanceof Error ? error.message : "The funding tracker could not be read.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (opened.current) return; // one read per visit, also when React mounts effects twice in development
    opened.current = true;
    void load();
  }, [load]);

  const data = answer?.configured && !("error" in answer) ? answer : null;
  const refused = answer?.configured && "error" in answer ? answer.error : null;
  const age = data ? exportAgeDays(data.exportedAt) : null;
  const stale = data !== null && (age === null || age > STALE_AFTER_DAYS);

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <header className="px-4 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="brand-label">00_FUNDING_TRACKER</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Where every investor conversation, application and bid stands.</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              A read-only copy of the tracker for admins, served from a file on this machine. Nothing here can be edited, and nothing is sent anywhere else.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={loading} onClick={() => void load()}>
              {loading ? "Reading…" : "Reload"}
            </Button>
            <Button asChild variant="outline">
              <Link to="/operator">Operator console</Link>
            </Button>
          </div>
        </div>
        {data && (
          <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-foreground" data-testid="funding-data-age">
            <StatusBadge tone={stale ? "caution" : "neutral"}>{stale ? "Stale copy" : "Copy"}</StatusBadge>
            <span>
              Exported <span className="font-mono tabular-nums">{exportedWords(data.exportedAt)}</span>
              {age !== null && age > 0 ? ` (${age} ${age === 1 ? "day" : "days"} ago)` : ""}; this is a copy, the Sheet is the source of truth.
            </span>
          </p>
        )}
      </header>

      <div className="grid gap-6 px-4 pb-10 sm:px-8">
        {failure && (
          <p role="alert" className="text-sm text-foreground">
            <StatusBadge tone="risk" className="mr-2">Unavailable</StatusBadge>
            {failure}
          </p>
        )}
        {refused && (
          <p role="alert" className="text-sm text-foreground">
            <StatusBadge tone="risk" className="mr-2">Export not shown</StatusBadge>
            {text(refused.message)}
          </p>
        )}
        {!answer && !failure && (
          <p role="status" className="font-mono text-sm text-muted-foreground">
            Reading the tracker export…
          </p>
        )}
        {answer && !answer.configured && <SwitchOn />}
        {data && <TrackerView data={data} />}
      </div>
    </main>
  );
}
