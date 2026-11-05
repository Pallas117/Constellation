import { useEffect, useState } from 'react';
import { Database, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/brand/StatusBadge';
import { apiBase } from "@/lib/api/base-url";
import { G4_DRIVERS, G4_PLASMA } from "@/lib/physics/live-drivers";

type RagStatus = {
  ok: boolean;
  /** false when the backend has no memory service set up (GAUSS_MEMORY_URL=off): the panel hides. */
  configured?: boolean;
  chunkCount?: number;
  error?: string;
};

type RagQueryResponse = {
  ok: boolean;
  answer?: string;
  sources?: { filePath: string; score: number }[];
  error?: string;
};

// Always through this backend: it applies the role policy and is the only way to the
// memory service, which listens on loopback without auth of its own.
const RAG_BASE = apiBase();

// Narrates the "Simulate G4" scene (HeliophysicsDashboard) without claiming more than Gauss does
// (GAU-63, GAU-228): what the scenario is, and only what Gauss computes from it. The numbers are the
// scene's own drivers, so the two can't disagree.
const SIMULATED_STORM_TEXT = `Simulated scenario: not live data and not a forecast.

The scene now runs on fixed severe-storm (G4) drivers instead of the measured L1 solar wind: IMF Bz ${G4_DRIVERS.bz} nT and By ${G4_DRIVERS.by} nT (GSM), speed ${G4_PLASMA.speed} km/s, density ${G4_PLASMA.density} cm⁻³, dynamic pressure ≈ ${G4_DRIVERS.pdyn} nPa, Kp ${G4_DRIVERS.kp}.

From these drivers Gauss computes the magnetopause stand-off distance (Shue et al. 1998; these drivers are outside the range that model was fitted to, so the result is extrapolated), whether geostationary orbit (6.6 Re) ends up outside the magnetopause, and the field lines drawn in the scene. The radiation points along the orbits are a stored example dataset, not a Gauss output.

Gauss gives no satellite impact assessment, drag estimate or confidence figure for this scenario. Choose "Back to live" to return to the measured drivers.`;

export function GaussRagPanel() {
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<{ filePath: string; score: number }[]>([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Source chip the user expanded
  const [activeTrace, setActiveTrace] = useState<string | null>(null);
  // True while the answer is the storm-scenario narration, not a model reply
  const [simulated, setSimulated] = useState(false);

  // Helper to parse text and render citation badges
  const renderTextWithTraces = (text: string) => {
    // Regex matches [Trace: Any Source Name]
    const parts = text.split(/(\[Trace:.*?\])/g);
    return parts.map((part, i) => {
      if (part.startsWith('[Trace:')) {
        const sourceName = part.replace('[Trace: ', '').replace(']', '');
        return (
          <button
            key={i}
            onClick={() => setActiveTrace(activeTrace === sourceName ? null : sourceName)}
            className="mx-1 inline-flex items-center gap-1 rounded border border-charcoal px-1.5 py-0.5 align-middle font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-expanded={activeTrace === sourceName}
            title={`Source: ${sourceName}`}
          >
            <Database size={10} aria-hidden="true" />
            Source
          </button>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  useEffect(() => {
    let intervalId: number | null = null;
    let currentIndex = 0;

    const clearStormInterval = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleStorm = (e: Event) => {
      if ((e as CustomEvent<boolean>).detail) {
        setSimulated(true);
        setAnswer("");
        setSources([]);
        currentIndex = 0;
        if (intervalId !== null) {
          return;
        }

        intervalId = window.setInterval(() => {
          if (currentIndex >= SIMULATED_STORM_TEXT.length) {
            clearStormInterval();
            return;
          }

          setAnswer((prev) => (prev || "") + SIMULATED_STORM_TEXT[currentIndex]);
          currentIndex += 1;
        }, 15);
      } else {
        setSimulated(false);
        setAnswer(null);
        clearStormInterval();
      }
    };

    window.addEventListener('simulate-g4-storm', handleStorm);
    return () => {
      window.removeEventListener('simulate-g4-storm', handleStorm);
      clearStormInterval();
    };
  }, []);

  useEffect(() => {
    // Indexing is an operator task on the memory host, not something this page can trigger.
    void (async () => {
      try {
        const res = await fetch(`${RAG_BASE}/api/rag/status`);
        setStatus((await res.json()) as RagStatus);
      } catch {
        setStatus({ ok: false, error: 'Knowledge base not reachable' });
      }
    })();
  }, []);

  async function handleAsk() {
    if (!question.trim()) return;
    setAsking(true);
    setError(null);
    setSimulated(false);
    setAnswer(null);
    setSources([]);
    try {
      const res = await fetch(`${RAG_BASE}/api/rag/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: question }),
      });
      const json = (await res.json()) as RagQueryResponse;
      if (!json.ok) {
        setError(json.error || 'Query failed');
      } else {
        setAnswer(json.answer || '');
        // Evidence comes back per chunk; list each source file once.
        const seen = new Set<string>();
        setSources((json.sources || []).filter((s) => !seen.has(s.filePath) && seen.add(s.filePath)));
      }
    } catch (e) {
      setError('Could not reach Gauss RAG server');
    } finally {
      setAsking(false);
    }
  }

  const chunkLabel = !status
    ? 'Checking knowledge base…'
    : !status.ok
      ? 'Knowledge base offline'
      : status.chunkCount
        ? `${status.chunkCount} knowledge chunks`
        : 'No documents indexed';
  // No memory service set up on this backend: there is nothing to search, so show no search box.
  // A service that is set up but down still shows, as "Knowledge base offline".
  if (status?.configured === false) return null;
  return (
    <section aria-labelledby="rag-title" className="hud-panel w-full space-y-3 p-4">
      <div className="min-w-0">
        <h2 id="rag-title" className="brand-label">06_LOGIC_ENGINE</h2>
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{chunkLabel}</p>
      </div>

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleAsk();
        }}
      >
        <label htmlFor="rag-question" className="sr-only">
          Question for the knowledge base
        </label>
        <textarea
          id="rag-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about current conditions…"
          className="h-20 w-full resize-none rounded-md border border-charcoal bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-signal focus-visible:outline-none"
        />
        <Button type="submit" variant="secondary" className="w-full" disabled={asking || !question.trim()}>
          <Search aria-hidden="true" />
          {asking ? 'Searching the knowledge base…' : 'Ask'}
        </Button>
      </form>

      {error && (
        <p role="alert" className="rounded-md border border-caution/50 px-3 py-2 text-sm text-caution">
          {error}
        </p>
      )}

      {answer && (
        <div className="space-y-2 border-t border-charcoal pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Answer</span>
            {simulated && <StatusBadge tone="caution">Simulated scenario</StatusBadge>}
          </div>
          <p className="max-h-60 overflow-y-auto whitespace-pre-wrap text-left text-sm leading-relaxed text-foreground">
            {renderTextWithTraces(answer)}
          </p>
          {activeTrace && (
            <p className="rounded-md border border-charcoal px-3 py-2 font-mono text-xs text-muted-foreground">
              Cited source: <span className="text-foreground">{activeTrace}</span>
            </p>
          )}
        </div>
      )}

      {sources.length > 0 && (
        <div className="border-t border-charcoal pt-2">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Sources</p>
          <ul className="max-h-16 space-y-0.5 overflow-y-auto text-left">
            {sources.map((s, i) => (
              <li key={`${s.filePath}-${i}`} className="truncate font-mono text-xs text-muted-foreground">
                {s.filePath}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
