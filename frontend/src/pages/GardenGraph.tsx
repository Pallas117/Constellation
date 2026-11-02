import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { getAuthHeaders } from "@/lib/api/auth";
import { apiBase } from "@/lib/api/base-url";
import { describeHttpFailure } from "@/lib/api/http-error";
import { layoutGarden, noteParts, resolveLink } from "@/lib/garden-layout";

// Cosmic Garden (GAU-222): the brain's markdown export as a graph. The backend filters notes by
// role (backend/memory/garden.ts), so this page only draws what it is sent. It loads once and on
// "Refresh"; it never polls (the garden is rebuilt hourly).

interface GardenNode {
  id: string;
  title: string;
  group: string;
}
interface Graph {
  nodes: GardenNode[];
  links: Array<{ source: string; target: string }>;
  builtAt: string;
}
interface Note {
  id: string;
  title: string;
  markdown: string;
}

const GROUP: Record<string, { label: string; fill: string }> = {
  member: { label: "Team documents", fill: "fill-sky-400" },
  operator: { label: "Operator documents", fill: "fill-amber-400" },
  memory: { label: "Agent memories (admin)", fill: "fill-violet-400" },
  map: { label: "Maps of content", fill: "fill-foreground" },
};
const W = 1000;
const H = 640;

async function get<T>(path: string, what: string): Promise<T> {
  const res = await fetch(`${apiBase()}/api/garden${path}`, { credentials: "include", headers: { ...(await getAuthHeaders()) } });
  if (!res.ok) throw new Error(describeHttpFailure(what, res.status));
  return (await res.json()) as T;
}

export default function GardenGraph() {
  useDocumentTitle("Cosmic Garden");
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // Loads on open and on each Refresh (reloads bumps). State changes only when a request
  // settles, or from the click that starts one, never synchronously inside the effect.
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let live = true;
    get<Graph>("/graph", "Loading the garden")
      .then((g) => {
        if (!live) return;
        setGraph(g);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load the garden"));
    return () => {
      live = false;
    };
  }, [reloads]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    get<Note>(`/note?id=${encodeURIComponent(selected)}`, "Opening the note")
      .then((n) => {
        if (!live) return;
        setNote(n);
        setNoteError(null);
      })
      .catch((err) => live && setNoteError(err instanceof Error ? err.message : "Couldn't open the note"));
    return () => {
      live = false;
    };
  }, [selected]);

  const placed = useMemo(() => (graph ? layoutGarden(graph.nodes, graph.links) : []), [graph]);
  const where = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const ids = useMemo(() => graph?.nodes.map((n) => n.id) ?? [], [graph]);
  const groups = useMemo(() => [...new Set(graph?.nodes.map((n) => n.group) ?? [])], [graph]);
  const match = filter.trim().toLowerCase();
  const open = (id: string) => {
    setNoteError(null);
    setSelected(id);
  };
  const neighbours = useMemo(() => {
    const s = new Set<string>();
    for (const l of graph?.links ?? []) {
      if (l.source === selected) s.add(l.target);
      if (l.target === selected) s.add(l.source);
    }
    return s;
  }, [graph, selected]);

  return (
    <main className="min-h-screen w-full bg-background text-foreground">
      <section className="px-4 py-6 sm:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="brand-label">00_COSMIC_GARDEN</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Cosmic Garden</h1>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              The knowledge the Cosmic Brain has approved, as linked notes. You see the notes your role covers: team documents for staff,
              plus operator documents for operators. Click a note to read it.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setError(null);
                setReloads((n) => n + 1);
              }}
            >
              Refresh
            </Button>
            <Button asChild variant="outline">
              <Link to="/mesh">Mesh &amp; devices</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-6 px-4 pb-10 sm:px-8 xl:grid-cols-[1.6fr_1fr]">
        <Card className="min-w-0">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
            <CardTitle>{graph ? `${graph.nodes.length} notes, ${graph.links.length} links` : "Notes"}</CardTitle>
            <input
              aria-label="Find a note"
              placeholder="Find a note"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-9 w-48 rounded-md border border-input bg-background px-3 text-sm"
            />
          </CardHeader>
          <CardContent className="space-y-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {graph && graph.nodes.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No notes for your role yet. Team documents appear here once they are approved into the brain's member corpus.
              </p>
            )}
            {graph && graph.nodes.length > 0 && (
              <>
                <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full rounded-md border border-border bg-muted/20" role="img" aria-label="Note graph">
                  {graph.links.map((l) => {
                    const a = where.get(l.source);
                    const b = where.get(l.target);
                    if (!a || !b) return null;
                    const lit = selected !== null && (l.source === selected || l.target === selected);
                    return (
                      <line
                        key={`${l.source}->${l.target}`}
                        x1={a.x * W}
                        y1={a.y * H}
                        x2={b.x * W}
                        y2={b.y * H}
                        className={lit ? "stroke-foreground" : "stroke-muted-foreground/30"}
                        strokeWidth={lit ? 1.5 : 1}
                      />
                    );
                  })}
                  {graph.nodes.map((n) => {
                    const p = where.get(n.id);
                    if (!p) return null;
                    const dim = (match && !n.title.toLowerCase().includes(match)) || (selected && n.id !== selected && !neighbours.has(n.id));
                    return (
                      <g
                        key={n.id}
                        transform={`translate(${p.x * W} ${p.y * H})`}
                        onClick={() => open(n.id)}
                        className="cursor-pointer"
                        opacity={dim ? 0.25 : 1}
                      >
                        <title>{n.title}</title>
                        <circle r={5 + Math.min(p.degree, 12)} className={GROUP[n.group]?.fill ?? "fill-muted-foreground"} />
                        {(p.degree >= 3 || n.id === selected) && (
                          <text y={-10 - Math.min(p.degree, 12)} textAnchor="middle" className="fill-foreground text-[13px]">
                            {n.title.length > 32 ? `${n.title.slice(0, 31)}…` : n.title}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </svg>
                <div className="flex flex-wrap gap-2 text-xs">
                  {groups.map((g) => (
                    <Badge key={g} variant="outline">
                      <svg width="10" height="10" className="mr-1.5" aria-hidden="true">
                        <circle cx="5" cy="5" r="5" className={GROUP[g]?.fill ?? "fill-muted-foreground"} />
                      </svg>
                      {GROUP[g]?.label ?? g}
                    </Badge>
                  ))}
                  <span className="text-muted-foreground">Rebuilt from the garden at {new Date(graph.builtAt).toLocaleString()}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{note && note.id === selected ? note.title : "Note"}</CardTitle>
          </CardHeader>
          <CardContent>
            {!selected && <p className="text-sm text-muted-foreground">Pick a note in the graph.</p>}
            {noteError && <p className="text-sm text-destructive">{noteError}</p>}
            {note && note.id === selected && (
              <div className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {noteParts(note.markdown).map((part, i) => {
                  if ("text" in part) return <span key={i}>{part.text}</span>;
                  const target = resolveLink(part.link, ids);
                  return target ? (
                    <button key={i} type="button" onClick={() => open(target)} className="text-primary underline underline-offset-2">
                      {part.label}
                    </button>
                  ) : (
                    <span key={i}>{part.label}</span>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
